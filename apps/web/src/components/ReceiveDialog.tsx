import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmtQty } from "../lib/format";

export interface ReceiveResult {
  /** Left out when everything that was sent arrived. */
  receivedQty?: number;
  note?: string;
}

// The receiving end of any movement between two places (a stock transfer, an R&D transfer, a transit-tracked issue). The sender's
// stock has already dropped by what it sent; the receiver says how much really arrived - less than was sent needs a reason, and the
// difference is kept as a recorded transit loss instead of silently disappearing - or refuses it, which gives it back to the sender.
export function ReceiveDialog({
  open,
  itemName,
  sentQty,
  unit,
  from,
  busy = false,
  canRefuse = true,
  onReceive,
  onRefuse,
  onCancel,
}: {
  open: boolean;
  itemName: string;
  sentQty: number;
  unit: string;
  from?: string;
  busy?: boolean;
  canRefuse?: boolean;
  onReceive: (r: ReceiveResult) => void;
  onRefuse: (reason: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"receive" | "refuse">("receive");
  const [received, setReceived] = useState(String(sentQty));
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("receive");
    setReceived(String(sentQty));
    setNote("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const qty = Number(received);
  const valid = Number.isFinite(qty) && qty > 0 && qty <= sentQty + 1e-9;
  const short = valid ? Math.round((sentQty - qty) * 1000) / 1000 : 0;
  const noteOk = note.trim().length >= 3;
  const canSubmit = mode === "receive" ? valid && (short <= 0 || noteOk) : noteOk;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={busy ? undefined : onCancel} />
      <div role="dialog" aria-modal="true" aria-label="Receive" className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-lift">
        <h2 className={`text-base font-black tracking-tight ${mode === "refuse" ? "text-rose-700" : "text-slate-900"}`}>{mode === "refuse" ? "Refuse this delivery" : "Confirm what arrived"}</h2>
        <p className="mt-1 text-sm text-slate-600">
          <b>{itemName}</b> - {fmtQty(sentQty)} {unit} was sent{from ? ` from ${from}` : ""}.
        </p>

        {mode === "receive" ? (
          <div className="mt-4 space-y-3">
            <div>
              <label className="label">How much arrived ({unit})</label>
              <input className="field font-mono" type="number" min="0" step="any" value={received} autoFocus onChange={(e) => setReceived(e.target.value)} />
              {valid && short > 0 && (
                <p className="mt-1 text-xs font-bold text-amber-700">
                  {fmtQty(short)} {unit} short - it will be recorded as lost in transit.
                </p>
              )}
              {!valid && received !== "" && <p className="mt-1 text-xs font-bold text-rose-600">Enter a quantity up to {fmtQty(sentQty)}.</p>}
            </div>
            {short > 0 && (
              <div>
                <label className="label">
                  What happened to the other {fmtQty(short)}? <span className="text-rose-500">*</span>
                </label>
                <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bag torn, spilled in transit" />
              </div>
            )}
            {short <= 0 && (
              <div>
                <label className="label">Note (optional)</label>
                <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <label className="label">
              Why is it being refused? <span className="text-rose-500">*</span>
            </label>
            <textarea className="field !h-20 !text-xs" value={note} autoFocus onChange={(e) => setNote(e.target.value)} placeholder="Wrong item, damaged, not expected…" />
            <p className="mt-1 text-xs text-slate-500">The material goes back to the sender&apos;s stock.</p>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {canRefuse && (
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => (setMode(mode === "receive" ? "refuse" : "receive"), setNote(""))}>
                {mode === "receive" ? "Refuse instead" : "Back"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
              Close
            </button>
            <button
              type="button"
              className={mode === "refuse" ? "inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50" : "btn-primary btn-sm"}
              disabled={busy || !canSubmit}
              onClick={() => (mode === "receive" ? onReceive({ receivedQty: short > 0 ? qty : undefined, note: note.trim() || undefined }) : onRefuse(note.trim()))}
            >
              {busy ? "Please wait…" : mode === "receive" ? "Confirm receipt" : "Refuse"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
