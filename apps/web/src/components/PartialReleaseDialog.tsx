import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { ApiError } from "../lib/api";
import { useReleaseInfo, useSendPlanToProduction } from "../lib/hooks";

// PPIC's "Send partial" popup: start Production with part of the order (for example the material already in hand) and release more
// later. The suggestion is only a guide - any quantity up to what is left to release can be sent.
export function PartialReleaseDialog({ open, poId, itemId, productName, onClose }: { open: boolean; poId: string; itemId: string; productName: string; onClose: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState("");
  const info = useReleaseInfo(poId, open ? itemId : null).data;
  const send = useSendPlanToProduction(poId);
  const unit = info?.unit ?? "";

  async function confirm() {
    const quantity = Number(qty);
    const left = info?.remainingQty;
    if (!Number.isFinite(quantity) || quantity <= 0) return toast.error("Enter a quantity greater than zero.");
    if (left != null && quantity > left + 1e-6) return toast.error(`Only ${left} ${unit} is left to release.`);
    try {
      await send.mutateAsync({ itemId, quantity });
      toast.success(`${quantity} ${unit} sent to Production.`);
      setQty("");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send");
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Send part of the order to Production?"
      confirmLabel="Send"
      message={
        <div className="space-y-2 text-left">
          <p>
            <b>{productName}</b>
            {info ? (
              <>
                : ordered <b>{info.orderQty} {unit}</b>, already released <b>{info.releasedQty}</b>, left to release <b>{info.remainingQty}</b>.
              </>
            ) : null}
          </p>
          {info?.suggestedQty != null && (
            <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
              The material you have now covers about <b>{info.suggestedQty} {unit}</b>
              {info.limitedBy ? <> (limited by {info.limitedBy})</> : null}. This is only a guide: you can send any quantity.{" "}
              <button type="button" className="font-bold text-brand-600 hover:underline" onClick={() => setQty(String(info.suggestedQty))}>
                Use {info.suggestedQty}
              </button>
            </p>
          )}
          <label className="block text-xs font-bold text-slate-600">
            Quantity to send {unit ? `(${unit})` : ""}
            <input className="field mt-1 font-mono" type="number" min="0" step="any" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
        </div>
      }
      busy={send.isPending}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
