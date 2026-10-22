import { usePoItemPlan, type PlanPreparation } from "../lib/hooks";
import { fmtQty } from "../lib/format";
import type { AddOnPlanDetail } from "../lib/types";

// What PPIC planned for one product, with quantities: the Raw Material (RM) plan and the Packaging (PM) plan, each material with
// the quantity required and whether it is covered. Read-only - this is Production's view of the plan PPIC sent.
// `showStock` false (Regulatory): only what the plan calls for (material, brand / spec, quantity) - stock and shortfall are not its concern.
function PlanTable({ title, plan, showStock }: { title: string; plan: AddOnPlanDetail; showStock: boolean }) {
  const short = showStock ? plan.materials.filter((m) => m.short).length : 0;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-2">
        <p className="text-micro font-bold uppercase tracking-wide text-slate-500">
          {title} <span className="font-normal normal-case text-slate-400">· {plan.planName} · calculated {new Date(plan.planCalculatedAt).toLocaleDateString()}</span>
        </p>
        <span className={`pill ${short ? "border-rose-200 bg-rose-50 text-rose-700" : showStock ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
          {plan.materials.length} material{plan.materials.length === 1 ? "" : "s"}
          {short ? ` · ${short} short` : ""}
        </span>
      </div>
      {plan.materials.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-400">No materials in this plan.</p>
      ) : (
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Material</th>
              <th className="px-3 py-2 text-right">Required Qty</th>
              {showStock && <th className="px-3 py-2 text-right">Available (Warehouse)</th>}
              {showStock && <th className="px-3 py-2">Status</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {plan.materials.map((m) => (
              <tr key={`${m.name}-${m.detail ?? ""}`}>
                <td className="px-3 py-2 font-bold text-slate-700">
                  {m.name}
                  {m.detail && <span className="ml-1.5 font-normal text-slate-400">{m.detail}</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">
                  {fmtQty(m.requiredQty)} {m.unit}
                </td>
                {showStock && <td className="px-3 py-2 text-right font-mono text-slate-600">{m.onHand == null ? "—" : `${fmtQty(m.onHand)} ${m.unit}`}</td>}
                {showStock && (
                  <td className="px-3 py-2">
                    {m.onHand == null ? (
                      <span className="text-slate-400">Not in catalog</span>
                    ) : m.short ? (
                      <span className="pill border-rose-200 bg-rose-50 text-rose-700">Short by {fmtQty(m.shortfallQty)}</span>
                    ) : (
                      <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Covered</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const dayText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : null);
const STAGE_ORDER = ["MATERIAL_RECEIVED", "INDENT_ISSUE", "DISPENSING", "SAMPLE_QC_APPROVAL"];

// The run's preparation, step by step, next to the plan: GRN (Day Store), Indent (Production), Dispensing (Day Store), Line Clearance (QA).
export function PreparationSteps({ prep }: { prep: PlanPreparation }) {
  const at = STAGE_ORDER.indexOf(prep.stage);
  const steps = [
    { label: "Material Received (GRN)", who: "Store", done: at > 0, detail: prep.grnNo ? `GRN ${prep.grnNo}${prep.grnDate ? ` · ${dayText(prep.grnDate)}` : ""}` : null },
    { label: "Indent Issue", who: "Production", done: at > 1, detail: prep.indentSlip ? `Slip ${prep.indentSlip}${prep.indentDate ? ` · ${dayText(prep.indentDate)}` : ""}` : null },
    { label: "Dispensing", who: "Store", done: at > 2, detail: prep.rmDispensingDate || prep.pmIssuedDate ? `RM ${dayText(prep.rmDispensingDate) ?? "—"} · PM ${dayText(prep.pmIssuedDate) ?? "—"}` : null },
    { label: "Line Clearance", who: "QA", done: prep.lineClearance === "Approved", detail: prep.lineClearance },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 text-micro font-bold uppercase tracking-wide text-slate-500">Preparation</p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {steps.map((s, i) => (
          <div key={s.label} className={`rounded-lg border px-2.5 py-2 ${s.done ? "border-emerald-200 bg-emerald-50/60" : i === current ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-slate-50/60"}`}>
            <p className="text-xs font-bold text-slate-800">{s.label}</p>
            <p className="text-micro text-slate-400">{s.who}</p>
            <p className={`mt-0.5 text-micro font-bold ${s.done ? "text-emerald-700" : i === current ? "text-amber-700" : "text-slate-400"}`}>{s.done ? "Done" : i === current ? "Pending now" : "Waiting"}</p>
            {s.detail && <p className="text-micro text-slate-500">{s.detail}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Production's view of the plan PPIC sent (with stock, the release and the preparation). With `forRegulatory`: just the materials the plan
 * calls for - Regulatory reviews a product by them, before it is sent to Production.
 */
export function PlanFromPpic({ poId, itemId, forRegulatory = false }: { poId: string; itemId: string; forRegulatory?: boolean }) {
  const { data, isLoading } = usePoItemPlan(poId, itemId, { released: !forRegulatory });
  if (isLoading || !data) return <div className="skeleton h-24 w-full" />;
  if (!data.rm && !data.bom) return <p className="text-xs text-slate-500">No calculated plan found for this product.</p>;
  const partial = !forRegulatory && data.release && data.release.releasedQty < data.release.orderQty - 1e-6;
  return (
    <div className="space-y-3">
      {partial && data.release && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          PPIC has released {fmtQty(data.release.releasedQty)} of {fmtQty(data.release.orderQty)} {data.release.unit} so far. The quantities below are for the released part.
        </p>
      )}
      {!forRegulatory && data.preparation && <PreparationSteps prep={data.preparation} />}
      {data.rm && <PlanTable title="Raw Material (RM) plan" plan={data.rm} showStock={!forRegulatory} />}
      {data.bom && <PlanTable title="Packaging (PM) plan" plan={data.bom} showStock={!forRegulatory} />}
    </div>
  );
}
