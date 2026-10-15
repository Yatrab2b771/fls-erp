import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// The Yes / No soft gate used before an action that is easy to click by
// accident (Generate, Hold, Release, Cancel, Send to Production, ...). Rendered
// into <body> so a table's overflow / transform can't clip or offset it.
// `requireReason` adds a mandatory reason box (Cancel) — Yes stays disabled
// until something meaningful is typed, and the text is handed to onConfirm.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Yes",
  cancelLabel = "No",
  tone = "brand",
  requireReason = false,
  reasonLabel = "Reason",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "brand" | "danger";
  requireReason?: boolean;
  reasonLabel?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  // A fresh dialog starts with an empty reason, and Escape means No.
  useEffect(() => {
    if (!open) return;
    setReason("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const reasonOk = !requireReason || reason.trim().length >= 3;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={busy ? undefined : onCancel} />
      <div role="dialog" aria-modal="true" aria-label={title} className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-lift">
        <h2 className={`text-base font-black tracking-tight ${tone === "danger" ? "text-rose-700" : "text-slate-900"}`}>{title}</h2>
        <div className="mt-2 text-sm text-slate-600">{message}</div>
        {requireReason && (
          <div className="mt-3">
            <label className="label">
              {reasonLabel} <span className="text-rose-500">*</span>
            </label>
            <textarea className="field !h-20 !text-xs" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Why is this being cancelled?" />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn-sm ${tone === "danger" ? "inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50" : "btn-primary"}`}
            disabled={busy || !reasonOk}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? "Please wait…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
