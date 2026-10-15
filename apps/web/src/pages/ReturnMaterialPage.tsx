import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ArrowLeftRight, ChevronDown, Download, PackageOpen, Plus } from "lucide-react";
import { useCreateRndTransfer, useRndReturns, useRndStoreStock, type RndReturnRow, type RndReturnStatus } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { ItemPicker } from "../components/ItemPicker";
import { VendorTable } from "./ReceivedMaterialPage";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

const STATUS_LABEL: Record<RndReturnStatus, string> = { SENT: "Sent · Warehouse to confirm", RETURNED: "Returned" };
const STATUS_PILL: Record<RndReturnStatus, string> = { SENT: "border-amber-200 bg-amber-50 text-amber-700", RETURNED: "border-emerald-200 bg-emerald-50 text-emerald-700" };
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

// Aging: from the day R&D sent it back to the day the Warehouse confirmed it (or to today while it is still waiting).
function agingOf(r: RndReturnRow): number {
  const end = r.status === "RETURNED" && r.returnedAt ? new Date(r.returnedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(r.sentAt).getTime()) / 86_400_000));
}

function NewReturnForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { data: stock } = useRndStoreStock();
  const create = useCreateRndTransfer();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [reason, setReason] = useState("");
  const holding = (stock ?? []).filter((s) => s.onHand > 0);
  const picked = holding.find((s) => s.item.id === itemId);

  async function send() {
    const qty = Number(quantity);
    if (!itemId) return toast.error("Select the material to return.");
    if (!Number.isFinite(qty) || qty <= 0) return toast.error("Enter a quantity greater than zero.");
    if (picked && qty > picked.onHand + 1e-9) return toast.error(`The R&D Store has only ${fmtQty(picked.onHand)} ${picked.item.unit ?? ""} of this.`);
    if (!unit.trim()) return toast.error("Enter the unit.");
    try {
      await create.mutateAsync({ direction: "TO_WAREHOUSE", itemId, quantity: qty, unit: unit.trim(), note: reason.trim() || undefined });
      toast.success("Sent back. The Warehouse will confirm receiving it.");
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send the return");
    }
  }

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <p className="text-sm font-black text-slate-800">New return to the Warehouse</p>
      {holding.length === 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          The R&D Store has no material on hand right now, so there is nothing to return yet. Once the Warehouse issues you material (Received Material) it will show up here.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="label">Material (what the R&D Store holds)</label>
          <ItemPicker
            items={holding.map((s) => ({ id: s.item.id, name: `${s.item.name} (${s.item.category}) · ${fmtQty(s.onHand)} ${s.item.unit ?? ""} on hand`, unit: s.item.unit }))}
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              const s = holding.find((x) => x.item.id === v);
              if (s?.item.unit) setUnit(s.item.unit);
            }}
            placeholder={holding.length ? "— Select a material —" : "— No material on hand —"}
          />
        </div>
        <div>
          <label className="label">Quantity {picked ? <span className="font-normal normal-case text-slate-400">(max {fmtQty(picked.onHand)})</span> : null}</label>
          <input className="field font-mono" type="number" min="0" step="any" disabled={holding.length === 0} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="label">Unit</label>
          <input className="field" disabled={holding.length === 0} value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div className="sm:col-span-4">
          <label className="label">Reason (optional)</label>
          <input className="field" disabled={holding.length === 0} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it going back? (trial finished, not needed...)" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={onDone}>
          Close
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={create.isPending || holding.length === 0} onClick={send}>
          {create.isPending ? "Sending…" : "Return to Warehouse"}
        </button>
      </div>
    </div>
  );
}

// R&D's fourth tile: send leftover material back to the Warehouse and see whether the Warehouse has confirmed it. One row per return,
// with the vendors the material came from and what R&D and the Warehouse hold now.
export function ReturnMaterialPage() {
  const { data, isLoading } = useRndReturns();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const vendorNames = (r: RndReturnRow) => distinct(r.vendors.map((v) => v.vendorName));

  const fields: FilterField[] = [
    { key: "material", label: "Material", options: distinct(all.map((r) => r.itemName)) },
    { key: "category", label: "Category", options: ["Raw Material", "Packaging Material"] },
    { key: "vendor", label: "Vendor", options: distinct(all.flatMap((r) => vendorNames(r))) },
    { key: "status", label: "Status", options: Object.values(STATUS_LABEL) },
    AGING_FIELD,
  ];
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;
  const rows = all.filter(
    (r) =>
      (!picked("material").length || picked("material").includes(r.itemName)) &&
      (!picked("category").length || picked("category").includes(CATEGORY_LABEL[r.category])) &&
      (!picked("vendor").length || vendorNames(r).some((v) => picked("vendor").includes(v))) &&
      (!picked("status").length || picked("status").includes(STATUS_LABEL[r.status])) &&
      (!from || r.sentAt.slice(0, 10) >= from) &&
      (!to || r.sentAt.slice(0, 10) <= to) &&
      inAgingBuckets(agingOf(r), picked("aging")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const count = (s: RndReturnStatus) => all.filter((r) => r.status === s).length;

  function download() {
    const lines = rows.map((r) => ({
      Material: r.itemName,
      Status: STATUS_LABEL[r.status],
      Category: CATEGORY_LABEL[r.category],
      Vendors: vendorNames(r).join(", "),
      Quantity: r.quantity,
      Unit: r.unit,
      "Sent On": day(r.sentAt),
      "Sent By": r.sentByName ?? "",
      "Returned On": day(r.returnedAt) === "—" ? "" : day(r.returnedAt),
      "Confirmed By": r.confirmedByName ?? "",
      "Aging (Days)": agingOf(r),
      Reason: r.reason ?? "",
      "R&D On Hand Now": r.rndOnHand,
      "Warehouse On Hand Now": r.warehouseOnHand,
    }));
    const vendorLines = rows.flatMap((r) =>
      r.vendors.map((v) => ({ Material: r.itemName, Category: CATEGORY_LABEL[r.category], Vendor: v.vendorName ?? "", "Batch No": v.batchNo ?? "", "GRN No": v.grnNo ?? "", "Mfg Date": day(v.mfgDate) === "—" ? "" : day(v.mfgDate), "Expiry Date": day(v.expiryDate) === "—" ? "" : day(v.expiryDate), "Received Qty": v.quantity, Unit: v.unit, "Received On": day(v.receivedAt) })),
    );
    const wb = XLSX.utils.book_new();
    const filterText = describeFilters(filters, fields, "Sent");
    addReportSheet(wb, "Returns", "FLS R&D - Return Material (sent back to the Warehouse)", filterText, lines, { totals: ["Quantity"] });
    addReportSheet(wb, "Vendors", "FLS R&D - Return Material (vendors of each material)", filterText, vendorLines);
    XLSX.writeFile(wb, stampedName("FLS_Return_Material"));
  }

  const chip = (s: RndReturnStatus) => (
    <button
      key={s}
      type="button"
      onClick={() => filters.applyPick("status", picked("status").includes(STATUS_LABEL[s]) ? [] : [STATUS_LABEL[s]])}
      className={`pill cursor-pointer ${STATUS_PILL[s]} ${picked("status").includes(STATUS_LABEL[s]) ? "ring-2 ring-brand-300" : ""}`}
    >
      {STATUS_LABEL[s]} · {count(s)}
    </button>
  );

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <ArrowLeftRight className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Return Material</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} return{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} — send material you do not need back to the Warehouse, and see when it confirms receiving it.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New return
          </button>
          <button type="button" className="btn-ghost btn-sm" disabled={rows.length === 0} onClick={download}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
          </button>
        </div>
      </div>

      {showForm && <NewReturnForm onDone={() => setShowForm(false)} />}

      <div className="flex flex-wrap gap-1.5">{(["SENT", "RETURNED"] as RndReturnStatus[]).map(chip)}</div>

      <TileFilterBar filters={filters} tileKey="return-material" fields={fields} dateLabel="Sent" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No returns yet"} hint={isFiltered ? "Nothing matches these filters." : "Use New return to send material back to the Warehouse."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Sent back</th>
                <th className="px-4 py-3">Returned</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const open = openId === r.id;
                const vs = vendorNames(r);
                const days = agingOf(r);
                return (
                  <Fragment key={r.id}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800">{r.itemName}</span>
                        <span className={`pill ml-2 text-micro ${r.category === "RM" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>{r.category}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`pill ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {vs[0] ?? "—"}
                        {vs.length > 1 && <span className="ml-1 text-micro text-slate-400">+{vs.length - 1} more</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(r.quantity)} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{day(r.sentAt)}</td>
                      <td className="px-4 py-3 text-slate-600">{day(r.returnedAt)}</td>
                      <td className="max-w-[16rem] truncate px-4 py-3 text-slate-500" title={r.reason ?? undefined}>
                        {r.reason ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`pill ${r.status === "RETURNED" ? "border-slate-200 bg-slate-50 text-slate-500" : days > 7 ? "border-rose-200 bg-rose-50 text-rose-700" : days > 3 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                          {days}d{r.status === "RETURNED" ? " ✓" : ""}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : r.id)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                        >
                          Details <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={9} className="space-y-3 px-4 py-4">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                              <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">Return</p>
                              <p className="text-slate-600">Sent by <b>{r.sentByName ?? "—"}</b> on {day(r.sentAt)}</p>
                              <p className="mt-1 text-slate-600">Confirmed by <b>{r.confirmedByName ?? "—"}</b> {r.returnedAt ? `on ${day(r.returnedAt)}` : ""}</p>
                              {r.reason && <p className="mt-1 text-slate-500">Reason: {r.reason}</p>}
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                              <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">R&D Store now</p>
                              <p className="font-mono text-base font-black text-slate-900">
                                {fmtQty(r.rndOnHand)} {r.unit}
                              </p>
                              <p className="text-slate-400">on hand</p>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                              <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">Warehouse now</p>
                              <p className="font-mono text-base font-black text-slate-900">
                                {fmtQty(r.warehouseOnHand)} {r.unit}
                              </p>
                              <p className="text-slate-400">on hand</p>
                            </div>
                          </div>
                          <VendorTable vendors={r.vendors} empty="No accepted receipt of this material yet, so no vendor to show." />
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
