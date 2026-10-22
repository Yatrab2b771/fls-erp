import { materialKindName } from "../lib/materialKind";
import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { AgingCell } from "./AgingCell";
import { ClientPager } from "./Pagination";
import { useClientPaging } from "../lib/useClientPaging";
import { fmtQty } from "../lib/format";
import type { InventoryReceiptStatus, InventoryTransaction } from "../lib/types";

// Material Received rows as one table (an Excel-like list): a column for each thing, a coloured QC status, paged. "Open" shows the full card of
// the row under it (`renderExpanded`), with every action the card has (QC, edit, debit note...), so nothing is lost by the table.

export const RECEIPT_STATUS: Record<InventoryReceiptStatus, { label: string; pill: string }> = {
  PENDING_QC: { label: "Pending QC", pill: "border-slate-200 bg-slate-50 text-slate-600" },
  TESTING: { label: "Testing", pill: "border-violet-200 bg-violet-50 text-violet-700" },
  ON_HOLD: { label: "On Hold", pill: "border-amber-200 bg-amber-50 text-amber-700" },
  QC_APPROVED: { label: "QC Approved", pill: "border-sky-200 bg-sky-50 text-sky-700" },
  QC_REJECTED: { label: "QC Rejected", pill: "border-rose-200 bg-rose-50 text-rose-700" },
  ACCEPTED: { label: "Accepted", pill: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
export const vendorPoOf = (t: InventoryTransaction) => t.vendorPurchaseOrderItem?.vendorPurchaseOrder.poNumber ?? null;

export function ReceivedTable({
  rows,
  renderExpanded,
  openLabel = "Open",
  showPo = false,
  showAging = false,
}: {
  rows: readonly InventoryTransaction[];
  renderExpanded: (t: InventoryTransaction) => ReactNode;
  openLabel?: string;
  /** A Vendor PO column (the delivery's own PO number). */
  showPo?: boolean;
  /** An Aging column: days since the delivery arrived. */
  showAging?: boolean;
}) {
  const pg = useClientPaging(rows);
  const [openId, setOpenId] = useState<string | null>(null);
  const columns = 13 + (showPo ? 1 : 0) + (showAging ? 1 : 0);
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              {showPo && <th className="px-4 py-3">Vendor PO</th>}
              <th className="px-4 py-3">QC Status</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Material</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3">Received</th>
              {showAging && <th className="px-4 py-3">Aging</th>}
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">GRN No.</th>
              <th className="px-4 py-3">Batch No.</th>
              <th className="px-4 py-3">Invoice No.</th>
              <th className="px-4 py-3">QC By</th>
              <th className="px-4 py-3">Accepted By</th>
              <th className="px-4 py-3">Remark</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pg.rows.map((t) => {
              const st = t.receiptStatus ? RECEIPT_STATUS[t.receiptStatus] : null;
              const isOpen = openId === t.id;
              return (
                <Fragment key={t.id}>
                  <tr className="transition hover:bg-slate-50">
                    {showPo && <td className="px-4 py-3 font-bold text-slate-700">{vendorPoOf(t) ?? <span className="font-normal text-slate-400">No PO (direct / opening stock)</span>}</td>}
                    <td className="px-4 py-3">{st ? <span className={`pill ${st.pill}`}>{st.label}</span> : <span className="text-slate-400">-</span>}</td>
                    <td className="px-4 py-3 font-bold text-slate-800">{t.item.name}</td>
                    <td className="px-4 py-3 text-slate-500">{materialKindName(t.item.category)}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {fmtQty(t.quantity)} {t.unit}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{day(t.date)}</td>
                    {showAging && (
                      <td className="px-4 py-3">
                        <AgingCell since={t.date} />
                      </td>
                    )}
                    <td className="px-4 py-3 text-slate-600">{t.vendorName ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{t.grnNo ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{t.batchNo ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{t.invoiceNo ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{t.qcCheckedBy ? `${t.qcCheckedBy.fullName} · ${day(t.qcCheckedAt)}` : "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{t.acceptedBy ? `${t.acceptedBy.fullName} · ${day(t.acceptedAt)}` : "-"}</td>
                    <td className="max-w-[16rem] truncate px-4 py-3 text-slate-500" title={t.remark ?? t.qcNote ?? ""}>
                      {t.remark ?? t.qcNote ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(isOpen ? null : t.id)} aria-expanded={isOpen}>
                        {openLabel} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={columns} className="whitespace-normal bg-slate-50/60 px-4 py-4">
                        <div className="sticky left-4 max-w-[min(100%,64rem)]">{renderExpanded(t)}</div>
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
  );
}
