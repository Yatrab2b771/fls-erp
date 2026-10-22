import { useState } from "react";
import { Link } from "react-router-dom";
import { GitBranch, Send } from "lucide-react";
import { ApiError } from "../lib/api";
import { useSendPlanToProduction } from "../lib/hooks";
import { useBomSwitchInfo, useSwitchBom, type BomSwitchResult, type PlanSlot } from "../lib/bomSwitchHooks";
import type { MaterialPlanningProduct } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";

// R&D's part of Material Planning and PO Readiness: see which BOM version a product's plan is made from (Display, V1 or V2), change it when the
// product is short of material and has to go to Production urgently, and, once it is changed and covered, send it to Production without PPIC.

const LABEL: Record<PlanSlot, string> = { DISPLAY: "Display BOM", V1: "V1", V2: "V2" };

export function SlotPill({ slot }: { slot: string }) {
  return slot === "DISPLAY" ? (
    <span className="pill border-slate-200 bg-slate-50 text-slate-500">Display BOM</span>
  ) : (
    <span className="pill border-violet-200 bg-violet-50 text-violet-700" title="R&D changed this product's plan to this version">
      {slot}
    </span>
  );
}

// Only what the control needs, so Material Planning, PO Readiness and the In Production list can all use it.
export type RndBomProduct = Pick<MaterialPlanningProduct, "purchaseOrderItemId" | "purchaseOrderId" | "productName" | "activeBomSlot"> & Partial<Pick<MaterialPlanningProduct, "heldAt" | "regulatoryStatus" | "plannedPlantId">>;

export function RndBomControl({ product, showSend = false }: { product: RndBomProduct; showSend?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [slot, setSlot] = useState<PlanSlot>("V1");
  const [result, setResult] = useState<BomSwitchResult | null>(null);
  const info = useBomSwitchInfo(open ? product.purchaseOrderItemId : null).data;
  const sw = useSwitchBom();
  const send = useSendPlanToProduction(product.purchaseOrderId);
  const changed = product.activeBomSlot !== "DISPLAY";
  const inProduction = info?.phase === "PRODUCTION";
  const sendBlocked = !changed
    ? "Change the plan to V1 or V2 first"
    : product.heldAt
      ? "On hold"
      : product.regulatoryStatus !== "Approved"
        ? "Waiting for Regulatory approval"
        : !product.plannedPlantId
          ? "PPIC has to assign a Plant first"
          : undefined;

  const options: { key: PlanSlot; text: string; disabled: boolean }[] = [
    { key: "DISPLAY", text: "Display BOM: the catalog's own (default, what the customer sees)", disabled: false },
    ...(["V1", "V2"] as const).map((k) => {
      const s = info?.slots[k];
      return { key: k as PlanSlot, text: !s ? `${k}: empty (make it in the RM BOM and Packaging BOM first)` : `${k}: ${s.rm ? "RM" : "RM from Display"} + ${s.pm ? "PM" : "PM from Display"}${s.note ? ` · ${s.note}` : ""}`, disabled: !s };
    }),
  ];

  // The choice shown is always one that can be applied: not the current version and not an empty one.
  const current = (info?.activeSlot ?? product.activeBomSlot) as PlanSlot;
  const usable = options.filter((o) => !o.disabled && o.key !== current);
  const chosen = usable.find((o) => o.key === slot)?.key ?? usable[0]?.key;

  function openDialog() {
    setResult(null);
    setOpen(true);
  }

  async function apply(reason: string) {
    if (!chosen) return;
    try {
      const res = await sw.mutateAsync({ purchaseOrderItemId: product.purchaseOrderItemId, slot: chosen, reason });
      setResult(res);
      toast.success(
        res.phase === "PRODUCTION"
          ? `${product.productName}: the batches not dispensed yet follow ${LABEL[res.slot]} now.`
          : res.ready
          ? `${product.productName}: the plan is made from ${LABEL[res.slot]} and every material is covered. It is in PO Readiness now.`
          : `${product.productName}: the plan is made from ${LABEL[res.slot]}. ${res.shortages.length} material(s) are still short.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not change the version");
    }
  }

  async function sendNow() {
    try {
      await send.mutateAsync(product.purchaseOrderItemId);
      toast.success(`${product.productName} sent to Production.`);
      setSendOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send to Production");
    }
  }

  return (
    <div className="inline-flex items-center justify-end gap-1.5">
      <SlotPill slot={product.activeBomSlot} />
      <button type="button" className="btn-ghost btn-sm" onClick={openDialog} title="Make this product's plan from Display, V1 or V2">
        <GitBranch className="h-3.5 w-3.5" strokeWidth={2.25} /> Version
      </button>
      {showSend && (
        <button type="button" className="btn-primary btn-sm" disabled={!!sendBlocked || send.isPending} title={sendBlocked ?? "Send the whole order to Production"} onClick={() => setSendOpen(true)}>
          <Send className="h-3.5 w-3.5" strokeWidth={2.25} /> Send to Production
        </button>
      )}

      <ConfirmDialog
        open={open}
        title={`BOM version: ${product.productName}`}
        confirmLabel={result ? "Change again" : "Change the plan"}
        cancelLabel="Close"
        requireReason
        reasonLabel={inProduction ? "Why (shown to Production and the Store)" : "Why (shown to PPIC and in the history)"}
        busy={sw.isPending}
        onConfirm={(reason) => {
          if (info?.locked) return toast.error(info.locked);
          if (!chosen) return toast.error("There is no other version to change to: make V1 or V2 first.");
          void apply(reason);
        }}
        onCancel={() => setOpen(false)}
        message={
          <div className="space-y-2.5 text-left">
            <p className="text-xs text-slate-500">
              {inProduction ? (
                <>
                  This product is with Production, made from <b>{LABEL[current] ?? current}</b> now. A new version applies to the batches <b>not dispensed yet</b>. A batch already dispensed keeps the material it was given, and what the new version still needs for it is asked from the Store as an <b>extra request for that batch</b>. Production and the Store are told; <b>PPIC is not</b>.
                </>
              ) : (
                <>
                  The plan is made from <b>{LABEL[current] ?? current}</b> now. Choosing another version works out the RM plan and the Packaging plan again from it. PPIC sees the new plan, and the Store's requests follow.
                </>
              )}
            </p>
            {info?.locked ? (
              <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-700">{info.locked} Its version can't be changed any more.</p>
            ) : (
              <div className="space-y-1.5">
                {options.map((o) => (
                  <label key={o.key} className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs ${o.disabled ? "border-slate-100 text-slate-300" : chosen === o.key ? "border-violet-300 bg-violet-50/60 text-slate-800" : "border-slate-200 text-slate-700"}`}>
                    <input type="radio" className="mt-0.5 accent-violet-600" name={`slot-${product.purchaseOrderItemId}`} disabled={o.disabled} checked={chosen === o.key} onChange={() => setSlot(o.key)} />
                    <span>
                      {o.text}
                      {o.key === current && <b className="ml-1.5 text-emerald-700">· current</b>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {!info?.locked && (
              <p className="text-micro text-slate-500">
                Make or edit V1 / V2 on the <Link to="/rm-costing" className="font-bold text-brand-700 hover:underline">RM BOM</Link> and <Link to="/packaging-bom" className="font-bold text-brand-700 hover:underline">Packaging BOM</Link> pages (pick the product, then V1 or V2).
              </p>
            )}
            {!info?.locked && !inProduction && (info?.onOrder.length ?? 0) > 0 && (
              <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                <b>Purchase already has a PI on:</b> {info!.onOrder.map((o) => `${o.material}${o.pis.length ? ` (${o.pis.join(", ")})` : ""}`).join(", ")}. {"These will still arrive even if the new plan does not need them; Purchase's other requests for this product follow the new plan by themselves."}
              </p>
            )}
            {result?.phase === "PRODUCTION" && (
              <div className="space-y-1.5 rounded-lg bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800">
                <b>Changed to {LABEL[result.slot]}.</b>
                {result.batches.length > 0 && (
                  <ul className="list-disc pl-4">
                    {result.batches.map((b, i) => (
                      <li key={i}>
                        {b.batchNo ?? "Batch"}: {b.dispensed ? "already dispensed, keeps its material (the rest comes as an extra request)" : "not dispensed yet, follows the new version"}
                      </li>
                    ))}
                  </ul>
                )}
                {result.extraRequests.length > 0 && (
                  <div>
                    <p className="font-bold">Asked from the Store (extra, for the batch):</p>
                    <ul className="list-disc pl-4">
                      {result.extraRequests.map((x, i) => (
                        <li key={i}>
                          {x.batchNo ?? "Batch"}: {x.material} {x.qty} {x.unit}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.changes.length > 0 && (
                  <div>
                    <p className="font-bold">Whole-order material that changes:</p>
                    <ul className="list-disc pl-4">
                      {result.changes.map((c) => (
                        <li key={`${c.type}-${c.material}`}>
                          {c.material} ({c.type}): {c.oldQty} → {c.newQty} {c.unit}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {result && result.phase !== "PRODUCTION" && (
              <div className={`rounded-lg px-2.5 py-2 text-xs ${result.ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                {result.ready ? (
                  <b>The plan is made from {LABEL[result.slot]} and every material is covered: the product is in PO Readiness now.</b>
                ) : (
                  <>
                    <b>The plan is made from {LABEL[result.slot]}. Still short:</b>
                    <ul className="mt-1 list-disc pl-4">
                      {result.shortages.map((s) => (
                        <li key={`${s.type}-${s.material}`}>
                          {s.material} ({s.type}): short {s.shortQty} {s.unit}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {(info?.switches.length ?? 0) > 0 && (
              <div>
                <p className="mb-1 text-micro font-bold uppercase tracking-wide text-slate-400">Earlier changes</p>
                <ul className="space-y-0.5 text-micro text-slate-500">
                  {info!.switches.slice(0, 4).map((s, i) => (
                    <li key={i}>
                      {s.fromSlot} → <b>{s.toSlot}</b> · {s.actorName ?? "—"} · {new Date(s.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        }
      />
      <ConfirmDialog
        open={sendOpen}
        title="Send to Production?"
        confirmLabel="Send"
        busy={send.isPending}
        message={
          <p className="text-left text-xs text-slate-600">
            <b>{product.productName}</b>: the whole order goes to Production with the plan made from <b>{LABEL[product.activeBomSlot as PlanSlot] ?? product.activeBomSlot}</b>. PPIC is not needed for this.
          </p>
        }
        onConfirm={() => void sendNow()}
        onCancel={() => setSendOpen(false)}
      />
    </div>
  );
}
