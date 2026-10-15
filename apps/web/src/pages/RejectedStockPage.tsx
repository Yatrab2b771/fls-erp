import { useState } from "react";
import { PackageX, RotateCcw, Trash2, Truck } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useRecordDisposition, useRejectedStock, useRemoveDisposition, type RejectedStockRow } from "../lib/stockControlHooks";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import { fmtQty } from "../lib/format";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";

// What inward QC refused is not in stock, but it is still in the building until it goes back to the vendor or is destroyed.
// Recording that here keeps the Quarantine clean and gives Accounts a physical return to match the Debit Note to.
export function RejectedStockPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("STORE");
  const [showAll, setShowAll] = useState(false);
  const { data: rows, isLoading } = useRejectedStock(showAll);
  const pg = useClientPaging(rows);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-rose-50 text-rose-600">
            <PackageX className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Rejected Stock</h1>
            <p className="text-sm text-slate-500">Deliveries QC rejected, still waiting to be sent back to the vendor or destroyed.</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show cleared ones too
        </label>
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} cols={7} />
      ) : !rows?.length ? (
        <EmptyState icon={PackageX} title="Nothing rejected is waiting" hint="Rejected material that is still here will be listed until it is returned or destroyed." accent="rose" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full whitespace-nowrap">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Vendor</th>
                  <th>GRN / Batch</th>
                  <th className="text-right">Rejected</th>
                  <th className="text-right">Returned</th>
                  <th className="text-right">Destroyed</th>
                  <th className="text-right">Still here</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => (
                  <RejectedRow key={r.id} row={r} canAct={canAct} />
                ))}
              </tbody>
            </table>
            <ClientPager pg={pg} />
          </div>
        </div>
      )}
    </div>
  );
}

function RejectedRow({ row, canAct }: { row: RejectedStockRow; canAct: boolean }) {
  const toast = useToast();
  const record = useRecordDisposition();
  const remove = useRemoveDisposition();
  const [open, setOpen] = useState<null | "RETURNED_TO_VENDOR" | "DESTROYED">(null);
  const [quantity, setQuantity] = useState(String(row.remainingQty));
  const [challanNo, setChallanNo] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [note, setNote] = useState("");

  async function submit() {
    if (!open) return;
    try {
      await record.mutateAsync({ receiptId: row.id, kind: open, quantity: Number(quantity), challanNo: challanNo.trim() || undefined, vehicleNo: vehicleNo.trim() || undefined, note: note.trim() || undefined });
      toast.success(open === "RETURNED_TO_VENDOR" ? "Return recorded." : "Destruction recorded.");
      setOpen(null);
      setChallanNo("");
      setVehicleNo("");
      setNote("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not record this");
    }
  }

  return (
    <>
      <tr>
        <td className="font-bold text-slate-800">
          {row.itemName}
          {row.reason && <span className="block max-w-[16rem] truncate text-micro font-normal text-slate-400">{row.reason}</span>}
        </td>
        <td className="text-slate-600">{row.vendorName ?? "—"}</td>
        <td className="text-slate-600">
          {row.grnNo ?? "—"}
          <span className="block text-micro text-slate-400">{row.batchNo ?? ""}</span>
        </td>
        <td className="text-right font-mono">
          {fmtQty(row.rejectedQty)} {row.unit}
        </td>
        <td className="text-right font-mono text-slate-500">{fmtQty(row.returnedQty)}</td>
        <td className="text-right font-mono text-slate-500">{fmtQty(row.destroyedQty)}</td>
        <td className={`text-right font-mono font-bold ${row.remainingQty > 0 ? "text-rose-700" : "text-emerald-700"}`}>{fmtQty(row.remainingQty)}</td>
        <td className="text-right">
          {canAct && row.remainingQty > 0 && (
            <div className="inline-flex gap-1.5">
              <button className="btn-ghost btn-sm" onClick={() => (setOpen("RETURNED_TO_VENDOR"), setQuantity(String(row.remainingQty)))}>
                <Truck className="h-3.5 w-3.5" /> Return to vendor
              </button>
              <button className="btn-ghost btn-sm" onClick={() => (setOpen("DESTROYED"), setQuantity(String(row.remainingQty)))}>
                <Trash2 className="h-3.5 w-3.5" /> Destroyed
              </button>
            </div>
          )}
        </td>
      </tr>
      {row.dispositions.length > 0 && (
        <tr>
          <td colSpan={8} className="bg-slate-50/60 !py-2 text-xs text-slate-500">
            {row.dispositions.map((d) => (
              <span key={d.id} className="mr-4 inline-flex items-center gap-1.5">
                {d.kind === "RETURNED_TO_VENDOR" ? "Returned" : "Destroyed"} {fmtQty(d.quantity)} on {new Date(d.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                {d.challanNo ? ` (challan ${d.challanNo})` : ""}
                {canAct && (
                  <button className="text-rose-500 hover:text-rose-700" title="Remove this entry" disabled={remove.isPending} onClick={() => remove.mutate(d.id)}>
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
          </td>
        </tr>
      )}
      {open && (
        <tr>
          <td colSpan={8} className="bg-brand-50/40">
            <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-5">
              <div>
                <label className="label">Quantity ({row.unit})</label>
                <input className="field font-mono" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div>
                <label className="label">{open === "RETURNED_TO_VENDOR" ? "Return challan no." : "Certificate no. (optional)"}</label>
                <input className="field" value={challanNo} onChange={(e) => setChallanNo(e.target.value)} />
              </div>
              <div>
                <label className="label">Vehicle no. (optional)</label>
                <input className="field" value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} />
              </div>
              <div>
                <label className="label">Note (optional)</label>
                <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="flex items-end gap-2">
                <button className="btn-primary btn-sm" disabled={record.isPending} onClick={submit}>
                  {record.isPending ? "Saving…" : open === "RETURNED_TO_VENDOR" ? "Record return" : "Record destruction"}
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setOpen(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
