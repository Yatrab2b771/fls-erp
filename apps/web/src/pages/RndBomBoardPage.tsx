import { Fragment, useMemo } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ClipboardList, Download, ExternalLink, FlaskConical, Package } from "lucide-react";
import { useBomBoard, type BomBoardRow, type BomPartStatus } from "../lib/bomBoardHooks";
import { useAuth } from "../lib/auth";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { RowActionMenu } from "../components/RowActionMenu";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

// R&D's BOM tile: every product on an approved PO that is not with Production yet, and whether its RM BOM (recipe) and its Packaging BOM are
// ready. Matched the way Generate matches them: customer + product name.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const PILL = { good: "border-emerald-200 bg-emerald-50 text-emerald-700", bad: "border-rose-200 bg-rose-50 text-rose-700", warn: "border-amber-200 bg-amber-50 text-amber-700", info: "border-sky-200 bg-sky-50 text-sky-700", na: "border-slate-200 bg-slate-50 text-slate-500" };

function PartPill({ status, version, kind, unit }: { status: BomPartStatus; version: number | null; kind: "RM" | "PM"; unit: string }) {
  const [cls, text] =
    status === "READY" ? [PILL.good, `Ready${version ? ` v${version}` : ""}`]
    : status === "MISSING" ? [PILL.bad, "Missing"]
    : status === "COMMON" ? [PILL.warn, "Common only"]
    : status === "OLD_SPEC" ? [PILL.info, "Old spec only"]
    : [PILL.na, `Not worked out (unit ${unit})`];
  return <span className={`pill whitespace-nowrap ${cls}`} title={kind === "RM" && status === "COMMON" ? "Only an older common recipe exists. R&D decides whether to use it for this customer." : kind === "PM" && status === "OLD_SPEC" ? "Only the old packaging spec exists. Convert it into a BOM table." : undefined}>{text}</span>;
}

const STATUS_OPTIONS = ["Complete", "Needs work", "RM missing", "RM common only", "Packaging missing", "Packaging old spec only", "Pack size missing"];
const statusMatch = (r: BomBoardRow, s: string) =>
  s === "Complete" ? !r.needsWork
  : s === "Needs work" ? r.needsWork
  : s === "RM missing" ? r.rm === "MISSING"
  : s === "RM common only" ? r.rm === "COMMON"
  : s === "Packaging missing" ? r.pm === "MISSING"
  : s === "Packaging old spec only" ? r.pm === "OLD_SPEC"
  : s === "Pack size missing" ? !r.packSizeKnown
  : false;

function overall(r: BomBoardRow): { text: string; cls: string } {
  if (!r.needsWork) return { text: "Complete", cls: PILL.good };
  const bits: string[] = [];
  if (r.rm === "MISSING") bits.push("RM");
  if (r.rm === "COMMON") bits.push("RM (choose)");
  if (r.pm === "MISSING") bits.push("Packaging");
  if (r.pm === "OLD_SPEC") bits.push("Packaging (convert)");
  if (!r.packSizeKnown) bits.push("Pack size");
  return { text: `Needs ${bits.join(" + ")}`, cls: PILL.warn };
}

export function RndBomBoardPage() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("RND", "ADMIN");
  const { data, isLoading } = useBomBoard();
  const filters = useTileFilters();
  const everyRow = data ?? [];
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.customerName)) },
    { key: "category", label: "Product Category", options: distinct(everyRow.map((r) => r.productCategory)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    { key: "bomStatus", label: "BOM Status", options: STATUS_OPTIONS },
    AGING_FIELD,
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return everyRow.filter(
      (r) =>
        (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(r.customerName)) &&
        (!picked("category").length || picked("category").includes(r.productCategory ?? "")) &&
        (!picked("product").length || picked("product").includes(r.productName)) &&
        (!picked("bomStatus").length || picked("bomStatus").some((s) => statusMatch(r, s))) &&
        inAgingBuckets(agingDays(r.waitingSince), picked("aging")) &&
        (!dateFrom || r.waitingSince.slice(0, 10) >= dateFrom) &&
        (!dateTo || r.waitingSince.slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyRow, filters.applied]);

  const pg = useClientPaging(rows);
  const needCount = everyRow.filter((r) => r.needsWork).length;
  const isFiltered = filters.activeCount > 0;
  const partText = (s: BomPartStatus, v: number | null) => (s === "READY" ? `Ready${v ? ` v${v}` : ""}` : s === "MISSING" ? "Missing" : s === "COMMON" ? "Common only" : s === "OLD_SPEC" ? "Old spec only" : "Not worked out");

  function download() {
    const lines = rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      Status: overall(r).text,
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Category: r.productCategory ?? "",
      Product: r.productName,
      Quantity: r.quantity,
      Unit: r.unit,
      "PO Date": day(r.orderDate),
      "PO Delivery Date": day(r.expectedDeliveryDate),
      "RM BOM": partText(r.rm, r.rmVersion),
      "Packaging BOM": partText(r.pm, r.pmVersion),
      "Pack Size": r.packSizeKnown ? "Known" : "Missing",
      "Waiting (days)": agingDays(r.waitingSince) ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "BOM", "FLS R&D: BOM status of PO products", describeFilters(filters, fields, "Waiting since"), lines);
    XLSX.writeFile(wb, stampedName("FLS_RND_BOM_Status"));
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
            <h1 className="text-2xl font-black tracking-tight text-slate-900">BOM</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} product{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` (of ${everyRow.length})` : ""}, {needCount} still need work. For each product on an approved PO: is its RM BOM and its Packaging BOM ready?
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="rnd-bom-board" fields={fields} dateLabel="PO approved" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title={isFiltered ? "Nothing matches these filters" : "No product waiting"} hint="Products show up here once BD approves their PO." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">PO</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5 text-right">Quantity</th>
                  <th className="px-3 py-2.5">Delivery</th>
                  <th className="px-3 py-2.5">RM BOM</th>
                  <th className="px-3 py-2.5">Packaging BOM</th>
                  <th className="px-3 py-2.5">Pack size</th>
                  <th className="px-3 py-2.5">Waiting</th>
                  <th className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r, i) => {
                  const newPo = i > 0 && pg.rows[i - 1]!.poId !== r.poId;
                  const st = overall(r);
                  const q = `customer=${encodeURIComponent(r.customerId)}&product=${encodeURIComponent(r.productName)}`;
                  return (
                    <Fragment key={r.itemId}>
                      <tr className={`border-b border-slate-50 ${newPo ? "border-t-2 border-t-slate-200" : ""}`}>
                        <td className="px-3 py-2.5 font-mono text-slate-700">{r.poNumber ?? "-"}</td>
                        <td className="px-3 py-2.5"><span className={`pill whitespace-nowrap ${st.cls}`}>{st.text}</span></td>
                        <td className="px-3 py-2.5 text-slate-600"><CustomerName name={r.customerName} /></td>
                        <td className="px-3 py-2.5 text-slate-600">{r.productCategory ?? "-"}</td>
                        <td className="px-3 py-2.5 font-bold text-slate-800">{r.productName}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-700">{fmtQty(r.quantity)} {r.unit}</td>
                        <td className="px-3 py-2.5 text-slate-600">{day(r.expectedDeliveryDate)}</td>
                        <td className="px-3 py-2.5"><PartPill status={r.rm} version={r.rmVersion} kind="RM" unit={r.unit} /></td>
                        <td className="px-3 py-2.5"><PartPill status={r.pm} version={r.pmVersion} kind="PM" unit={r.unit} /></td>
                        <td className="px-3 py-2.5"><span className={`pill ${r.packSizeKnown ? PILL.good : PILL.bad}`}>{r.packSizeKnown ? "Known" : "Missing"}</span></td>
                        <td className="px-3 py-2.5"><AgingCell since={r.waitingSince} /></td>
                        <td className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">
                          <RowActionMenu
                            actions={[
                              { label: r.rm === "READY" ? "View the RM BOM" : "Make the RM BOM", icon: <FlaskConical className="h-3.5 w-3.5" strokeWidth={2.5} />, to: `/rm-costing?${q}`, hidden: r.rm === "NOT_APPLICABLE" },
                              { label: r.rm === "COMMON" && canEdit ? "Use the common recipe for this customer" : "", icon: <FlaskConical className="h-3.5 w-3.5" strokeWidth={2.5} />, to: `/rm-costing?${q}`, hidden: !(r.rm === "COMMON" && canEdit) },
                              { label: r.pm === "READY" ? "View the Packaging BOM" : "Make the Packaging BOM", icon: <Package className="h-3.5 w-3.5" strokeWidth={2.5} />, to: `/packaging-bom?${q}` },
                              { label: "Open PO", icon: <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.5} />, to: `/po-review/${r.poId}` },
                            ]}
                          />
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-micro text-slate-500">
            <span><b className="text-emerald-700">Ready v2</b>: saved BOM and its version</span>
            <span><b className="text-rose-700">Missing</b>: nothing saved for this customer and product</span>
            <span><b className="text-amber-700">Common only</b>: only an older common recipe, R&amp;D decides</span>
            <span><b className="text-sky-700">Old spec only</b>: only the old packaging spec, convert it</span>
            <span><b className="text-rose-700">Pack size</b>: needed to turn Kg into packs and packs into Kg</span>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
