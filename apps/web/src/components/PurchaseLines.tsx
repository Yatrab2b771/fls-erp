import { useState } from "react";
import { CheckCircle2, Pencil, Trash2 } from "lucide-react";
import { ApiError } from "../lib/api";
import { useDeletePurchaseLine, useInventoryVendors, useSetRequirementPurchase, useUpdatePurchaseLine } from "../lib/hooks";
import type { PreInventoryRequirement, PurchaseLine } from "../lib/types";
import { useToast } from "./Toast";

function suggestPiNumber(r: PreInventoryRequirement): string {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, ""); // yymmdd
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PI-${r.category}-${datePart}-${suffix}`;
}

const fmtQty = (n: number) => String(Math.round(n * 100) / 100);
/** "11 Oct 2026" - unambiguous, unlike 10/11/2026. */
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

/**
 * Log one PI line for part (or all) of a shortfall - or edit an already-logged line.
 * Quantity defaults to everything still to log, so the single-PI case stays one click;
 * to split 100 Kg as 20 + 40 + 40, log 20, then 40, then 40.
 */
export function PiLogForm({ requirement, line, onDone }: { requirement: PreInventoryRequirement; line?: PurchaseLine; onDone: () => void }) {
  const toast = useToast();
  const setPurchase = useSetRequirementPurchase();
  const updateLine = useUpdatePurchaseLine();
  const { data: vendors } = useInventoryVendors();
  const isEditing = !!line;
  // Most this line can take: what is left to log (plus its own quantity when editing).
  const maxQty = isEditing ? requirement.remainingToLog + Math.max(0, line.quantity - line.receivedQty) + line.receivedQty : requirement.remainingToLog;

  const [quantity, setQuantity] = useState(fmtQty(isEditing ? line.quantity : requirement.remainingToLog));
  const [piNumber, setPiNumber] = useState(line?.piNumber ?? suggestPiNumber(requirement));
  const [vendorName, setVendorName] = useState(line?.vendorName ?? "");
  const [eta, setEta] = useState(line ? line.eta.slice(0, 10) : "");
  const [error, setError] = useState<string | null>(null);
  const pending = setPurchase.isPending || updateLine.isPending;

  async function handleSave() {
    setError(null);
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return setError("Enter the quantity this PI covers.");
    if (qty > maxQty + 0.005) return setError(`Only ${fmtQty(maxQty)} ${requirement.unit} can go on this PI.`);
    if (!piNumber.trim() || !vendorName.trim() || !eta) return setError("PI Number, Vendor Name, and ETA are all required.");
    try {
      if (line) {
        await updateLine.mutateAsync({ requirementId: requirement.id, lineId: line.id, poNumber: piNumber.trim(), vendorName: vendorName.trim(), eta, quantity: qty });
        toast.success("PI details updated.");
      } else {
        await setPurchase.mutateAsync({ id: requirement.id, poNumber: piNumber.trim(), vendorName: vendorName.trim(), eta, quantity: qty });
        const left = Math.max(0, requirement.remainingToLog - qty);
        toast.success(left > 0.005 ? `PI logged — ${fmtQty(left)} ${requirement.unit} still to log.` : "PI logged — Finance has been notified.");
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the PI");
    }
  }

  return (
    <div className="animate-fade-in rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="mb-2.5 text-tiny font-semibold text-slate-500">
        {isEditing ? "Editing this PI line" : "Log a PI for this shortfall"} · <span className="font-mono font-bold text-slate-700">{fmtQty(requirement.remainingToLog)}</span> {requirement.unit} still to log
        {!isEditing && requirement.onOrderQty > 0 && (
          <>
            {" "}
            · <span className="font-mono font-bold text-slate-700">{fmtQty(requirement.onOrderQty)}</span> {requirement.unit} already on PIs
          </>
        )}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Quantity ({requirement.unit})</label>
          <input className="field font-mono" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="label">PI Number</label>
          <input className="field font-mono" value={piNumber} onChange={(e) => setPiNumber(e.target.value)} />
        </div>
        <div>
          <label className="label">Vendor Name</label>
          <input className="field" list={`pi-vendor-options-${requirement.id}`} placeholder="Pick a known vendor or type a new one" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
          <datalist id={`pi-vendor-options-${requirement.id}`}>
            {vendors?.vendors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label">ETA</label>
          <input type="date" className="field" value={eta} onChange={(e) => setEta(e.target.value)} />
        </div>
        {error && <p className="text-xs font-bold text-rose-600 sm:col-span-4">{error}</p>}
        <div className="flex justify-end gap-2 sm:col-span-4">
          <button type="button" className="btn-ghost btn-sm" onClick={onDone}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={handleSave}>
            {pending ? "Saving…" : isEditing ? "Update PI" : "Save PI"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The PI lines a shortfall has been split into: quantity, PI Number, Vendor, ETA, and what has arrived. */
export function PurchaseLineList({ requirement, canPurchase, variant = "list" }: { requirement: PreInventoryRequirement; canPurchase: boolean; variant?: "list" | "table" }) {
  const toast = useToast();
  const deleteLine = useDeletePurchaseLine();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (requirement.purchaseLines.length === 0) return null;

  async function handleRemove(line: PurchaseLine) {
    if (!window.confirm(`Remove this PI line — ${fmtQty(line.quantity)} ${requirement.unit} on ${line.piNumber} (${line.vendorName})?`)) return;
    try {
      await deleteLine.mutateAsync({ requirementId: requirement.id, lineId: line.id });
      toast.success("PI line removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove the PI line");
    }
  }

  if (variant === "table") {
    return (
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
            <th className="py-1.5 pr-4">PI No</th>
            <th className="py-1.5 pr-4">Vendor</th>
            <th className="py-1.5 pr-4 text-right">Ordered Qty</th>
            <th className="py-1.5 pr-4">ETA</th>
            <th className="py-1.5 pr-4">Status</th>
            <th className="py-1.5 pr-4">Finance</th>
            {canPurchase && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {requirement.purchaseLines.map((line) => {
            if (editingId === line.id) {
              return (
                <tr key={line.id}>
                  <td colSpan={canPurchase ? 7 : 6} className="py-2">
                    <PiLogForm requirement={requirement} line={line} onDone={() => setEditingId(null)} />
                  </td>
                </tr>
              );
            }
            const received = line.status === "RECEIVED";
            const overdue = !received && new Date(line.eta) < new Date(new Date().toDateString());
            return (
              <tr key={line.id}>
                <td className="py-2 pr-4 font-bold text-brand-700">{line.piNumber}</td>
                <td className="py-2 pr-4 text-slate-600">{line.vendorName}</td>
                <td className="whitespace-nowrap py-2 pr-4 text-right font-mono font-bold text-slate-800">
                  {fmtQty(line.quantity)} {requirement.unit}
                </td>
                <td className={`whitespace-nowrap py-2 pr-4 ${overdue ? "font-semibold text-rose-700" : "text-slate-600"}`}>
                  {fmtDate(line.eta)}
                  {overdue ? " (Overdue)" : ""}
                </td>
                <td className="py-2 pr-4">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {received ? (
                      <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Received</span>
                    ) : line.receivedQty > 0 ? (
                      <span className="pill border-amber-200 bg-amber-50 text-amber-700">
                        {fmtQty(line.receivedQty)} of {fmtQty(line.quantity)} arrived
                      </span>
                    ) : (
                      <span className="text-slate-500">On order</span>
                    )}
                    {line.correctedAt && (
                      <span className="pill border-blue-200 bg-blue-50 text-blue-700" title={`Corrected ${new Date(line.correctedAt).toLocaleString()}`}>
                        Updated
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  {line.finance ? (
                    <span className="inline-flex flex-col gap-0.5" title={line.finance.remarks ?? ""}>
                      <span className={`pill ${{ PAID_PARTIAL: "border-sky-200 bg-sky-50 text-sky-700", PAID_FULL: "border-emerald-200 bg-emerald-50 text-emerald-700", ON_HOLD: "border-violet-200 bg-violet-50 text-violet-700", REJECTED: "border-rose-200 bg-rose-50 text-rose-700" }[line.finance.status]}`}>
                        {{ PAID_PARTIAL: "Part paid", PAID_FULL: "Paid in full", ON_HOLD: "On hold", REJECTED: "Rejected" }[line.finance.status]}
                      </span>
                      {line.finance.remarks && <span className="max-w-[14rem] truncate text-micro text-slate-500">{line.finance.remarks}</span>}
                    </span>
                  ) : (
                    <span className="text-slate-300">Waiting</span>
                  )}
                </td>
                {canPurchase && (
                  <td className="whitespace-nowrap py-2 text-right">
                    {!received && (
                      <>
                        <button type="button" className="btn-icon" title="Edit this PI line" onClick={() => setEditingId(line.id)}>
                          <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                        </button>
                        {line.receivedQty <= 0 && (
                          <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove this PI line" disabled={deleteLine.isPending} onClick={() => handleRemove(line)}>
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                          </button>
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <ul className="space-y-1.5">
      {requirement.purchaseLines.map((line) => {
        if (editingId === line.id) {
          return (
            <li key={line.id}>
              <PiLogForm requirement={requirement} line={line} onDone={() => setEditingId(null)} />
            </li>
          );
        }
        const received = line.status === "RECEIVED";
        const overdue = !received && new Date(line.eta) < new Date(new Date().toDateString());
        const arrived = line.receivedQty > 0 && !received;
        return (
          <li key={line.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs ${received ? "border-emerald-100 bg-emerald-50/50 text-slate-500" : "border-brand-100 bg-brand-50/40 text-slate-700"}`}>
            <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${received ? "text-emerald-500" : "text-brand-500"}`} strokeWidth={2.5} />
            <span className="font-mono font-bold">
              {fmtQty(line.quantity)} {requirement.unit}
            </span>
            <span className="font-bold text-brand-700">{line.piNumber}</span>
            <span>{line.vendorName}</span>
            <span className={overdue ? "font-semibold text-rose-700" : ""}>
              ETA {new Date(line.eta).toLocaleDateString()}
              {overdue ? " (Overdue)" : ""}
            </span>
            {received && <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Received</span>}
            {arrived && (
              <span className="pill border-amber-200 bg-amber-50 text-amber-700">
                {fmtQty(line.receivedQty)} of {fmtQty(line.quantity)} arrived
              </span>
            )}
            {line.correctedAt && (
              <span className="pill border-blue-200 bg-blue-50 text-blue-700" title={`Corrected ${new Date(line.correctedAt).toLocaleString()}`}>
                Updated
              </span>
            )}
            {canPurchase && !received && (
              <span className="ml-auto flex items-center gap-1">
                <button type="button" className="btn-icon" title="Edit this PI line" onClick={() => setEditingId(line.id)}>
                  <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                </button>
                {line.receivedQty <= 0 && (
                  <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove this PI line" disabled={deleteLine.isPending} onClick={() => handleRemove(line)}>
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
