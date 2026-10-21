import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, FlaskConical, PackageOpen } from "lucide-react";
import { useRndUtilization, type RndUtilizationLog, type RndUtilizationRow } from "../lib/hooks";
import { VendorTable } from "./ReceivedMaterialPage";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { customerTypeLabel } from "../lib/customerTags";

// The utilization fields, in the order they are shown.
const FIELDS = [
  { key: "testingQty", label: "Testing", tone: "text-sky-700" },
  { key: "formulationQty", label: "Formulation", tone: "text-violet-700" },
  { key: "customerSampleQty", label: "Customer sample", tone: "text-emerald-700" },
  { key: "rejectedQty", label: "Rejected", tone: "text-rose-700" },
  { key: "returnedQty", label: "Return", tone: "text-amber-700" },
  { key: "wastageQty", label: "Wastage", tone: "text-orange-700" },
] as const;
const KIND_LABEL: Record<RndUtilizationLog["kind"], string> = { TESTING: "Testing", FORMULATION_TRIAL: "Formulation", WASTAGE: "Wastage", REJECTED: "Rejected", CUSTOMER_SAMPLE: "Customer sample", RETURN: "Return" };
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const q = (n: number, unit: string) => (n ? `${fmtQty(n)} ${unit}` : "—");

// Every vendor / source a material came from: the vendors of the Warehouse deliveries, and the supplier of a direct purchase.
function vendorsOf(r: RndUtilizationRow): string[] {
  return [...new Set([...r.lots.map((l) => l.vendorName), ...(r.lots.some((l) => l.source === "Warehouse") ? r.warehouseVendors.map((v) => v.vendorName) : [])].filter((v): v is string => !!v))];
}
const sourcesOf = (r: RndUtilizationRow) => [...new Set(r.lots.map((l) => (l.source === "Warehouse" ? "Warehouse issue" : "Direct purchase")))];

// R&D's tile before Return Material: for each material that reached the R&D Store, where it came from, how much and when, and what
// became of it - Testing, Formulation, Customer sample, Rejected, Return, Wastage - and what is left in stock.
export function RndMaterialUtilizationPage() {
  const { data, isLoading } = useRndUtilization();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const fields: FilterField[] = [
    { key: "material", label: "Material", options: distinct(all.map((r) => r.itemName)) },
    { key: "category", label: "Category", options: ["Raw Material", "Packaging Material"] },
    { key: "vendor", label: "Vendor", options: distinct(all.flatMap(vendorsOf)) },
    { key: "source", label: "Came from", options: ["Warehouse issue", "Direct purchase"] },
    { key: "stock", label: "Stock", options: ["In stock", "Used up"] },
    { key: "field", label: "Utilization field", options: FIELDS.map((f) => f.label) },
    { key: "customer", label: "Customer (sample)", options: distinct(all.flatMap((r) => r.log.map((l) => l.customerName))) },
    { key: "project", label: "Project / Formulation", options: distinct(all.flatMap((r) => r.log.flatMap((l) => [l.projectName, l.formulationRef]))) },
  ];
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;
  const rows = all.filter(
    (r) =>
      (!picked("material").length || picked("material").includes(r.itemName)) &&
      (!picked("category").length || picked("category").includes(CATEGORY_LABEL[r.category])) &&
      (!picked("vendor").length || vendorsOf(r).some((v) => picked("vendor").includes(v))) &&
      (!picked("source").length || sourcesOf(r).some((s) => picked("source").includes(s))) &&
      (!picked("stock").length || picked("stock").includes(r.stockQty > 0 ? "In stock" : "Used up")) &&
      (!picked("field").length || FIELDS.some((f) => picked("field").includes(f.label) && r[f.key] > 0)) &&
      (!picked("customer").length || r.log.some((l) => l.customerName && picked("customer").includes(l.customerName))) &&
      (!picked("project").length || r.log.some((l) => (l.projectName && picked("project").includes(l.projectName)) || (l.formulationRef && picked("project").includes(l.formulationRef)))) &&
      (!from || (r.lastReceivedAt ?? "").slice(0, 10) >= from) &&
      (!to || (r.lastReceivedAt ?? "").slice(0, 10) <= to),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;

  function download() {
    const summary = rows.map((r) => ({
      Material: r.itemName,
      Category: CATEGORY_LABEL[r.category],
      Vendors: vendorsOf(r).join(", "),
      "Came From": sourcesOf(r).join(", "),
      Unit: r.unit,
      "Received Qty": r.receivedQty,
      "Receipts": r.lots.length,
      "First Received At R&D": day(r.firstReceivedAt) === "—" ? "" : day(r.firstReceivedAt),
      "Last Received At R&D": day(r.lastReceivedAt) === "—" ? "" : day(r.lastReceivedAt),
      Testing: r.testingQty,
      Formulation: r.formulationQty,
      "Customer Sample": r.customerSampleQty,
      Rejected: r.rejectedQty,
      Return: r.returnedQty,
      Wastage: r.wastageQty,
      "Stock Now": r.stockQty,
    }));
    const receipts = rows.flatMap((r) => r.lots.map((l) => ({ Material: r.itemName, Category: CATEGORY_LABEL[r.category], "Received At R&D": day(l.receivedAt), Quantity: l.quantity, Unit: l.unit, "Came From": l.source === "Warehouse" ? "Warehouse issue" : "Direct purchase", Vendor: l.vendorName ?? "", "Invoice No": l.invoiceNo ?? "", "Batch No": l.batchNo ?? "", "Expiry Date": day(l.expiryDate) === "—" ? "" : day(l.expiryDate) })));
    const usage = rows.flatMap((r) =>
      r.log.map((l) => ({ Material: r.itemName, Category: CATEGORY_LABEL[r.category], Date: day(l.date), Type: KIND_LABEL[l.kind], Quantity: l.quantity, Unit: l.unit, Customer: l.customerName ?? "", "Customer Type": customerTypeLabel(l.customerName ?? ""), Brand: l.brandName ?? "", Project: l.projectName ?? "", "Formulation Ref": l.formulationRef ?? "", "Batch No": l.batchNo ?? "", Note: l.note ?? "" })),
    );
    const wb = XLSX.utils.book_new();
    const filterText = describeFilters(filters, fields, "Last received");
    addReportSheet(wb, "Summary", "FLS R&D - Material Utilization (per material)", filterText, summary, { totals: ["Received Qty", "Testing", "Formulation", "Customer Sample", "Rejected", "Return", "Wastage", "Stock Now"] });
    addReportSheet(wb, "Receipts", "FLS R&D - Material Utilization (receipts at the R&D Store)", filterText, receipts);
    addReportSheet(wb, "Usage Log", "FLS R&D - Material Utilization (every usage entry)", filterText, usage);
    XLSX.writeFile(wb, stampedName("FLS_RnD_Material_Utilization"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <FlaskConical className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Material Utilization</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} material{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} that reached the R&D Store — where from, how much, and what became of it. Open Utilization on a row.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="rnd-material-utilization" fields={fields} dateLabel="Last received" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing in the R&D Store yet"} hint={isFiltered ? "Nothing matches these filters." : "A material shows here once it has been received at the R&D Store."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3 text-right">Quantity received</th>
                <th className="px-4 py-3">Received at R&D</th>
                <th className="px-4 py-3 text-right">Stock now</th>
                <th className="px-4 py-3">Utilization</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const open = openId === r.itemId;
                const vs = vendorsOf(r);
                return (
                  <Fragment key={r.itemId}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3 text-slate-600">
                        {vs[0] ?? "—"}
                        {vs.length > 1 && <span className="ml-1 text-micro text-slate-400">+{vs.length - 1} more</span>}
                        <span className="block text-micro text-slate-400">{sourcesOf(r).join(" · ")}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800">{r.itemName}</span>
                        <span className={`pill ml-2 text-micro ${r.category === "RM" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>{r.category}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(r.receivedQty)} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {day(r.lastReceivedAt)}
                        {r.lots.length > 1 && <span className="block text-micro text-slate-400">{r.lots.length} receipts</span>}
                      </td>
                      <td className={`px-4 py-3 text-right font-mono font-bold ${r.stockQty > 0 ? "text-emerald-700" : "text-slate-300"}`}>{q(r.stockQty, r.unit)}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : r.itemId)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                        >
                          Utilization <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={6} className="space-y-3 px-4 py-4">
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                            {FIELDS.map((f) => (
                              <div key={f.key} className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-micro font-bold uppercase tracking-wide text-slate-400">{f.label}</p>
                                <p className={`mt-0.5 font-mono text-sm font-black ${r[f.key] ? f.tone : "text-slate-300"}`}>{q(r[f.key], r.unit)}</p>
                              </div>
                            ))}
                            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                              <p className="text-micro font-bold uppercase tracking-wide text-emerald-700">Stock</p>
                              <p className="mt-0.5 font-mono text-sm font-black text-emerald-800">
                                {fmtQty(r.stockQty)} {r.unit}
                              </p>
                            </div>
                          </div>

                          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                            <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-micro font-bold uppercase tracking-wide text-slate-500">Received at the R&D Store</p>
                            <table className="w-full whitespace-nowrap text-xs">
                              <thead>
                                <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                  <th className="px-3 py-2">Received</th>
                                  <th className="px-3 py-2 text-right">Quantity</th>
                                  <th className="px-3 py-2">Came from</th>
                                  <th className="px-3 py-2">Vendor</th>
                                  <th className="px-3 py-2">Invoice</th>
                                  <th className="px-3 py-2">Batch</th>
                                  <th className="px-3 py-2">Expiry</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {r.lots.map((l) => (
                                  <tr key={l.id}>
                                    <td className="px-3 py-2 text-slate-600">{day(l.receivedAt)}</td>
                                    <td className="px-3 py-2 text-right font-mono text-slate-800">
                                      {fmtQty(l.quantity)} {l.unit}
                                    </td>
                                    <td className="px-3 py-2 text-slate-600">{l.source === "Warehouse" ? "Warehouse issue" : "Direct purchase"}</td>
                                    <td className="px-3 py-2 text-slate-600">{l.vendorName ?? (l.source === "Warehouse" ? "see vendors below" : "—")}</td>
                                    <td className="px-3 py-2 text-slate-500">{l.invoiceNo ?? "—"}</td>
                                    <td className="px-3 py-2 text-slate-500">{l.batchNo ?? "—"}</td>
                                    <td className="px-3 py-2 text-slate-500">{day(l.expiryDate)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                            <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-micro font-bold uppercase tracking-wide text-slate-500">Every usage entry</p>
                            {r.log.length === 0 ? (
                              <p className="px-3 py-3 text-xs text-slate-400">Nothing used yet.</p>
                            ) : (
                              <table className="w-full whitespace-nowrap text-xs">
                                <thead>
                                  <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                    <th className="px-3 py-2">Date</th>
                                    <th className="px-3 py-2">Type</th>
                                    <th className="px-3 py-2 text-right">Quantity</th>
                                    <th className="px-3 py-2">Customer / Brand</th>
                                    <th className="px-3 py-2">Project</th>
                                    <th className="px-3 py-2">Formulation</th>
                                    <th className="px-3 py-2">Batch</th>
                                    <th className="px-3 py-2">Note</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {r.log.map((l) => (
                                    <tr key={l.id}>
                                      <td className="px-3 py-2 text-slate-600">{day(l.date)}</td>
                                      <td className="px-3 py-2 font-bold text-slate-700">{KIND_LABEL[l.kind]}</td>
                                      <td className="px-3 py-2 text-right font-mono text-slate-800">
                                        {fmtQty(l.quantity)} {l.unit}
                                      </td>
                                      <td className="px-3 py-2 text-slate-600">{[l.customerName, l.brandName].filter(Boolean).join(" · ") || "—"}</td>
                                      <td className="px-3 py-2 text-slate-500">{l.projectName ?? "—"}</td>
                                      <td className="px-3 py-2 text-slate-500">{l.formulationRef ?? "—"}</td>
                                      <td className="px-3 py-2 text-slate-500">{l.batchNo ?? "—"}</td>
                                      <td className="px-3 py-2 text-slate-500">{l.note ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>

                          {r.warehouseVendors.length > 0 && (
                            <div>
                              <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">Vendors of this material at the Warehouse</p>
                              <VendorTable vendors={r.warehouseVendors} empty="" />
                            </div>
                          )}
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
