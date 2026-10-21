import { Fragment, useState } from "react";
import { ReceiveDialog, type ReceiveResult } from "../components/ReceiveDialog";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, PackageCheck, PackageOpen, Plus } from "lucide-react";
import { useCancelRndSampleRequest, useConfirmRndTransfer, useRejectRndTransfer, useCreateRndSampleRequest, useImportRndSampleRequests, useInventoryItems, useReceivedMaterial, useRndItemInfo, type ReceivedMaterialRow, type ReceivedMaterialStatus, type ReceivedMaterialVendor } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { ItemPicker } from "../components/ItemPicker";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

const STATUS_LABEL: Record<ReceivedMaterialStatus, string> = { REQUESTED: "Requested", ISSUED: "Issued · receive it", RECEIVED: "Received", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const STATUS_PILL: Record<ReceivedMaterialStatus, string> = {
  REQUESTED: "border-amber-200 bg-amber-50 text-amber-700",
  ISSUED: "border-sky-200 bg-sky-50 text-sky-700",
  RECEIVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-500",
};
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

// Aging: from the day R&D asked to the day it received (or to today while it is still Requested / Issued). Rejected and Cancelled have none.
function agingOf(r: ReceivedMaterialRow): number | null {
  if (r.status === "REJECTED" || r.status === "CANCELLED") return null;
  const end = r.status === "RECEIVED" && r.receivedAt ? new Date(r.receivedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(r.requestedAt).getTime()) / 86_400_000));
}

export function VendorTable({ vendors, empty }: { vendors: ReceivedMaterialVendor[]; empty: string }) {
  if (vendors.length === 0) return <p className="text-xs text-slate-400">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
            <th className="px-3 py-2">Vendor</th>
            <th className="px-3 py-2">Batch</th>
            <th className="px-3 py-2">GRN</th>
            <th className="px-3 py-2">Mfg date</th>
            <th className="px-3 py-2">Expiry</th>
            <th className="px-3 py-2 text-right">Received qty</th>
            <th className="px-3 py-2">Received on</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {vendors.map((v, i) => (
            <tr key={i}>
              <td className="px-3 py-2 font-bold text-slate-700">{v.vendorName ?? "—"}</td>
              <td className="px-3 py-2 text-slate-600">{v.batchNo ?? "—"}</td>
              <td className="px-3 py-2 text-slate-600">{v.grnNo ?? "—"}</td>
              <td className="px-3 py-2 text-slate-500">{day(v.mfgDate)}</td>
              <td className="px-3 py-2 text-slate-500">{day(v.expiryDate)}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-700">
                {fmtQty(v.quantity)} {v.unit}
              </td>
              <td className="px-3 py-2 text-slate-500">{day(v.receivedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewRequestForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { data: items } = useInventoryItems();
  const create = useCreateRndSampleRequest();
  const importRows = useImportRndSampleRequests();
  // A material that is not in the list yet: R&D names it and picks RM or PM, and it is added to the item list with the request.
  const [isNew, setIsNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<"RM" | "PM">("RM");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const { data: info } = useRndItemInfo(itemId || null);

  async function send() {
    const qty = Number(quantity);
    if (!isNew && !itemId) return toast.error("Select a material.");
    if (isNew && !newName.trim()) return toast.error("Enter the new material's name.");
    if (!Number.isFinite(qty) || qty <= 0) return toast.error("Enter a quantity greater than zero.");
    if (!unit.trim()) return toast.error("Enter the unit.");
    try {
      if (isNew) {
        const name = newName.trim();
        const existing = (items ?? []).find((i) => i.category === newCategory && i.name.toLowerCase() === name.toLowerCase());
        if (existing) return toast.error(`${existing.name} is already in the list. Pick it from the list instead.`);
        const res = await importRows.mutateAsync({ rows: [{ category: newCategory, itemName: name, quantity: qty, unit: unit.trim(), note: note.trim() || undefined }] });
        toast.success(res.itemsCreated ? `${name} added as a new ${newCategory === "RM" ? "raw" : "packaging"} material and requested from the Warehouse.` : "Request sent to the Warehouse.");
      } else {
        await create.mutateAsync({ itemId, quantity: qty, unit: unit.trim(), note: note.trim() || undefined });
        toast.success("Request sent to the Warehouse.");
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send the request");
    }
  }

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <p className="text-sm font-black text-slate-800">New request to the Warehouse</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {isNew ? (
          <>
            <div>
              <label className="label">New material name</label>
              <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Ashwagandha Extract" autoFocus />
            </div>
            <div>
              <label className="label">Type</label>
              <ItemPicker items={[{ id: "RM", name: "Raw Material (RM)" }, { id: "PM", name: "Packaging Material (PM)" }]} value={newCategory} onChange={(v) => setNewCategory(v as "RM" | "PM")} clearable={false} />
            </div>
          </>
        ) : (
          <div className="sm:col-span-2">
            <label className="label">Material</label>
            <ItemPicker
              items={(items ?? []).map((i) => ({ id: i.id, name: `${i.name} (${i.category})`, unit: i.unit }))}
              value={itemId}
              onChange={(v) => {
                setItemId(v);
                const picked = (items ?? []).find((i) => i.id === v);
                if (picked?.unit) setUnit(picked.unit);
              }}
              placeholder="— Select a material —"
            />
          </div>
        )}
        <div>
          <label className="label">Quantity</label>
          <input className="field font-mono" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="label">Unit</label>
          <input className="field" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div className="sm:col-span-4">
          <label className="label">Note (optional)</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is it for?" />
        </div>
      </div>
      <button
        type="button"
        className="text-xs font-bold text-brand-600 hover:underline"
        onClick={() => {
          setIsNew((v) => !v);
          setItemId("");
        }}
      >
        {isNew ? "← Pick a material that is already in the list" : "Material not in the list? Add a new material"}
      </button>
      {isNew && <p className="text-tiny text-slate-500">A new material is added to the item list with this request. The Warehouse will see it and issue it once it has stock.</p>}
      {!isNew && info && (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <p className="text-xs font-bold text-slate-600">
            Warehouse has <span className="font-mono text-slate-900">{fmtQty(info.warehouseOnHand)} {info.unit ?? ""}</span> of {info.name} on hand
            {info.warehouseOnHand <= 0 && <span className="ml-2 text-rose-600">· none in stock right now</span>}
          </p>
          <VendorTable vendors={info.vendors} empty="No accepted receipt of this material yet, so no vendor to show." />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={onDone}>
          Close
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={create.isPending || importRows.isPending} onClick={send}>
          {create.isPending || importRows.isPending ? "Sending…" : "Send request"}
        </button>
      </div>
    </div>
  );
}

// R&D's third tile: ask the Warehouse for material, and confirm receiving what it issues. One row per request, from Requested to Received,
// with the vendors the material came from and what the Warehouse has on hand.
export function ReceivedMaterialPage() {
  const { data, isLoading } = useReceivedMaterial();
  const toast = useToast();
  const cancel = useCancelRndSampleRequest();
  const confirm = useConfirmRndTransfer();
  const reject = useRejectRndTransfer();
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const vendorNames = (r: ReceivedMaterialRow) => distinct(r.vendors.map((v) => v.vendorName));

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
      (!from || r.requestedAt.slice(0, 10) >= from) &&
      (!to || r.requestedAt.slice(0, 10) <= to) &&
      inAgingBuckets(agingOf(r), picked("aging")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const count = (s: ReceivedMaterialStatus) => all.filter((r) => r.status === s).length;

  async function confirmReceived(r: ReceivedMaterialRow, got: ReceiveResult) {
    if (!r.transferId) return;
    try {
      await confirm.mutateAsync({ id: r.transferId, receivedQty: got.receivedQty, note: got.note });
      toast.success(`${r.itemName} received into the R&D Store.`);
      setReceivingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not confirm");
    }
  }
  async function refuseReceived(r: ReceivedMaterialRow, reason: string) {
    if (!r.transferId) return;
    try {
      await reject.mutateAsync({ id: r.transferId, reason });
      toast.success("Refused - the material is back with the Warehouse.");
      setReceivingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not refuse");
    }
  }
  async function cancelRequest(r: ReceivedMaterialRow) {
    if (!r.requestId || !window.confirm(`Cancel the request for ${r.itemName}?`)) return;
    try {
      await cancel.mutateAsync(r.requestId);
      toast.success("Request cancelled.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not cancel");
    }
  }

  function download() {
    const lines = rows.map((r) => ({
      Material: r.itemName,
      Status: STATUS_LABEL[r.status],
      Category: CATEGORY_LABEL[r.category],
      Vendors: vendorNames(r).join(", "),
      Quantity: r.quantity,
      Unit: r.unit,
      "Requested On": day(r.requestedAt),
      "Requested By": r.requestedByName ?? "",
      "Issued On": day(r.issuedAt) === "—" ? "" : day(r.issuedAt),
      "Issued By": r.issuedByName ?? "",
      "Received On": day(r.receivedAt) === "—" ? "" : day(r.receivedAt),
      "Aging (Days)": agingOf(r) ?? "",
      "Warehouse On Hand": r.warehouseOnHand,
      Note: r.note ?? "",
      "Rejection Reason": r.rejectionReason ?? "",
    }));
    const vendorLines = rows.flatMap((r) =>
      r.vendors.map((v) => ({ Material: r.itemName, Category: CATEGORY_LABEL[r.category], Vendor: v.vendorName ?? "", "Batch No": v.batchNo ?? "", "GRN No": v.grnNo ?? "", "Mfg Date": day(v.mfgDate) === "—" ? "" : day(v.mfgDate), "Expiry Date": day(v.expiryDate) === "—" ? "" : day(v.expiryDate), "Received Qty": v.quantity, Unit: v.unit, "Received On": day(v.receivedAt) })),
    );
    const wb = XLSX.utils.book_new();
    const filterText = describeFilters(filters, fields, "Requested");
    addReportSheet(wb, "Requests", "FLS R&D - Received Material (requests to the Warehouse)", filterText, lines, { totals: ["Quantity"] });
    addReportSheet(wb, "Vendors", "FLS R&D - Received Material (vendors of each material)", filterText, vendorLines);
    XLSX.writeFile(wb, stampedName("FLS_Received_Material"));
  }

  const chip = (s: ReceivedMaterialStatus) => (
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

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <PackageCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Received Material</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} request{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} — ask the Warehouse for material, and confirm when what it issued reaches you.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New request
          </button>
          <button type="button" className="btn-ghost btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
          </button>
        </div>
      </div>

      {showForm && <NewRequestForm onDone={() => setShowForm(false)} />}

      <div className="flex flex-wrap gap-1.5">{(["REQUESTED", "ISSUED", "RECEIVED", "REJECTED", "CANCELLED"] as ReceivedMaterialStatus[]).map(chip)}</div>

      <TileFilterBar filters={filters} tileKey="received-material" fields={fields} dateLabel="Requested" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No requests yet"} hint={isFiltered ? "Nothing matches these filters." : "Use New request to ask the Warehouse for material."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Issued</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const open = openId === r.key;
                const vs = vendorNames(r);
                const days = agingOf(r);
                return (
                  <Fragment key={r.key}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800">{r.itemName}</span>
                        <span className={`pill ml-2 text-micro ${r.category === "RM" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>{r.category}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`pill ${STATUS_PILL[r.status]}`} title={r.rejectionReason ?? undefined}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {vs[0] ?? "—"}
                        {vs.length > 1 && <span className="ml-1 text-micro text-slate-400">+{vs.length - 1} more</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(r.quantity)} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{day(r.requestedAt)}</td>
                      <td className="px-4 py-3 text-slate-600">{day(r.issuedAt)}</td>
                      <td className="px-4 py-3 text-slate-600">{day(r.receivedAt)}</td>
                      <td className="px-4 py-3">
                        {days == null ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <span className={`pill ${r.status === "RECEIVED" ? "border-slate-200 bg-slate-50 text-slate-500" : days > 7 ? "border-rose-200 bg-rose-50 text-rose-700" : days > 3 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                            {days}d{r.status === "RECEIVED" ? " ✓" : ""}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {r.status === "ISSUED" && (
                          <>
                            <button type="button" className="btn-primary btn-sm" disabled={confirm.isPending} onClick={() => setReceivingId(r.transferId ?? r.requestId ?? "")}>
                              Confirm received
                            </button>
                            <ReceiveDialog
                              open={receivingId === (r.transferId ?? r.requestId ?? "")}
                              itemName={r.itemName}
                              sentQty={r.quantity}
                              unit={r.unit}
                              from="the Warehouse"
                              busy={confirm.isPending || reject.isPending}
                              onReceive={(got) => void confirmReceived(r, got)}
                              onRefuse={(reason) => void refuseReceived(r, reason)}
                              onCancel={() => setReceivingId(null)}
                            />
                          </>
                        )}
                        {r.status === "REQUESTED" && r.requestId && (
                          <button type="button" className="btn-ghost btn-sm !text-rose-600" disabled={cancel.isPending} onClick={() => void cancelRequest(r)}>
                            Cancel
                          </button>
                        )}
                        {(r.status === "RECEIVED" || r.status === "REJECTED" || r.status === "CANCELLED") && <span className="text-tiny text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : r.key)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                        >
                          Details <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={10} className="space-y-3 px-4 py-4">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                              <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">Request</p>
                              <p className="text-slate-600">Requested by <b>{r.requestedByName ?? "—"}</b> on {day(r.requestedAt)}</p>
                              {r.note && <p className="mt-1 text-slate-500">Note: {r.note}</p>}
                              {r.rejectionReason && <p className="mt-1 font-semibold text-rose-600">Rejected: {r.rejectionReason}</p>}
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                              <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">Issued and received</p>
                              <p className="text-slate-600">Issued by <b>{r.issuedByName ?? "—"}</b> {r.issuedAt ? `on ${day(r.issuedAt)}` : ""}</p>
                              <p className="mt-1 text-slate-600">Received by <b>{r.receivedByName ?? "—"}</b> {r.receivedAt ? `on ${day(r.receivedAt)}` : ""}</p>
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
