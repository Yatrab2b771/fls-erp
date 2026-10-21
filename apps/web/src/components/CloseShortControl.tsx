import { useState } from "react";
import { Ban, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCloseShort, useReopenShort } from "../lib/heldProductHooks";
import type { PlanBoardRow } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { fmtQty } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";

/**
 * Close short: the batches made less than was ordered and no more will be made. The product then ends at what it made; the order completes
 * once that has been dispatched. Production does it, only when every batch is done. A product already closed short shows where it ended, with a
 * way to take it back.
 */
export function CloseShortControl({ row }: { row: PlanBoardRow }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const close = useCloseShort();
  const reopen = useReopenShort();
  const [asking, setAsking] = useState<"close" | "reopen" | null>(null);
  const canAct = hasRole("PRODUCTION");

  const run = row.run;
  if (!run?.batchFlow || row.batches.length === 0) return null;
  const made = run.combinedQty;

  if (row.closedShort) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <span className="font-bold text-slate-800">
            Closed short at {fmtQty(row.closedShort.qty ?? made)} {row.unit} of {fmtQty(row.quantity)} {row.unit}
          </span>
          {row.closedShort.reason && <span className="text-slate-500">“{row.closedShort.reason}”</span>}
          {canAct && (
            <button type="button" className="btn-ghost btn-sm ml-auto" onClick={() => setAsking("reopen")}>
              <Undo2 className="h-3.5 w-3.5" /> Reopen
            </button>
          )}
        </div>
        <ConfirmDialog
          open={asking === "reopen"}
          tone="brand"
          title="Reopen this product?"
          message={<>{row.productName} is ordered for the full {fmtQty(row.quantity)} {row.unit} again, and Production can make the rest.</>}
          confirmLabel="Reopen"
          busy={reopen.isPending}
          onConfirm={() =>
            reopen.mutate(
              { itemId: row.itemId },
              {
                onSuccess: () => {
                  toast.success("Reopened.");
                  setAsking(null);
                },
                onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not reopen"),
              },
            )
          }
          onCancel={() => setAsking(null)}
        />
      </>
    );
  }

  // Only when every batch is done and something is really missing
  const allDone = row.batches.every((b) => b.status === "COMPLETED");
  const missing = row.releasedQty - made;
  if (!canAct || !allDone || missing <= 1e-6) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-rose-200 bg-rose-50/40 px-3 py-2.5 text-xs text-slate-600">
        <span>
          Made {fmtQty(made)} of {fmtQty(row.releasedQty)} {row.unit}. Not making the rest?
        </span>
        <button type="button" className="btn-ghost btn-sm ml-auto text-rose-700" onClick={() => setAsking("close")}>
          <Ban className="h-3.5 w-3.5" /> Close short
        </button>
      </div>
      <ConfirmDialog
        open={asking === "close"}
        tone="danger"
        title="Close this product short?"
        message={
          <>
            <b>{row.productName}</b> ends at what was made: {fmtQty(made)} {row.unit} of the {fmtQty(row.releasedQty)} {row.unit} ordered. The rest ({fmtQty(missing)} {row.unit}) will not be made. The order counts as complete once the {fmtQty(made)} {row.unit} has been dispatched. BD is told.
          </>
        }
        requireReason
        reasonLabel="Why is it being closed short?"
        confirmLabel="Close short"
        busy={close.isPending}
        onConfirm={(reason) =>
          close.mutate(
            { itemId: row.itemId, reason },
            {
              onSuccess: () => {
                toast.success(`${row.productName} is closed short.`);
                setAsking(null);
              },
              onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not close it short"),
            },
          )
        }
        onCancel={() => setAsking(null)}
      />
    </>
  );
}
