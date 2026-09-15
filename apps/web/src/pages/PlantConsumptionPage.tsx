import { useState } from "react";
import { Factory, PackageMinus } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useDayStores,
  usePlantConsumptionBalance,
  usePlants,
  usePlantStock,
  usePreProductionsByPlant,
  useRecordPlantConsumption,
  type RecordPlantConsumptionPayload,
} from "../lib/hooks";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { PreProduction } from "../lib/types";

// Plant records, per production run, how much RM/PM it consumed / wasted
// / rejected / returned to a store — requirement I. Distinct from
// Dispensing's own consumption logging (Inventory module, STORE-only,
// tied to the DISPENSING pipeline stage) — this is Production's own
// after-the-fact accounting, any time material has actually reached the
// Plant.
export function PlantConsumptionPage() {
  const { hasRole } = useAuth();
  const canRecord = hasRole("PRODUCTION");
  const { data: plants } = usePlants();
  const [plantId, setPlantId] = useState("");
  const { data: runs, isLoading: runsLoading } = usePreProductionsByPlant(plantId || undefined);
  const [selectedRunId, setSelectedRunId] = useState("");

  const selectedRun = runs?.find((r) => r.id === selectedRunId);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <PackageMinus className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Plant Consumption</h1>
          <p className="text-sm text-slate-500">Record what actually happened to material issued to a Plant — consumed, wasted, rejected, or returned.</p>
        </div>
      </div>

      <div className="card p-5 sm:p-6">
        <label className="label">Plant</label>
        <div className="max-w-sm">
          <ItemPicker items={(plants ?? []).map((p) => ({ id: p.id, name: p.name }))} value={plantId} onChange={(v) => { setPlantId(v); setSelectedRunId(""); }} placeholder="— Select a Plant —" icon={Factory} />
        </div>
      </div>

      {!plantId ? (
        <p className="text-xs text-slate-400">Pick a Plant to see its production runs.</p>
      ) : runsLoading ? (
        <SkeletonRows rows={3} cols={3} />
      ) : !runs?.length ? (
        <EmptyState icon={Factory} title="No production runs at this Plant" accent="brand" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            {runs.map((r) => (
              <RunListItem key={r.id} run={r} selected={r.id === selectedRunId} onSelect={() => setSelectedRunId(r.id)} />
            ))}
          </div>
          <div>{selectedRun ? <RunDetail run={selectedRun} plantId={plantId} canRecord={canRecord} /> : <p className="text-xs text-slate-400">Select a run to see its balance and record entries.</p>}</div>
        </div>
      )}
    </div>
  );
}

function RunListItem({ run, selected, onSelect }: { run: PreProduction; selected: boolean; onSelect: () => void }) {
  return (
    <button
      className={`card w-full p-3 text-left transition ${selected ? "!border-brand-300 !bg-brand-50/60" : "hover:!border-slate-300"}`}
      onClick={onSelect}
    >
      <p className="truncate font-bold text-slate-800">{run.purchaseOrderItem.productName}</p>
      <p className="text-xs text-slate-500">
        {run.purchaseOrderItem.purchaseOrder.poNumber ?? "No PO #"} · {run.purchaseOrderItem.purchaseOrder.customer.companyName}
      </p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{run.currentStageId.replace(/_/g, " ")}</p>
    </button>
  );
}

function RunDetail({ run, plantId, canRecord }: { run: PreProduction; plantId: string; canRecord: boolean }) {
  const { data: balance, isLoading: balanceLoading } = usePlantConsumptionBalance(run.id);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Balance for this run</h2>
        {balanceLoading ? (
          <SkeletonRows rows={2} cols={6} />
        ) : !balance?.items.length ? (
          <p className="text-xs text-slate-400">Nothing logged against this run yet.</p>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-modern w-full">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Consumed</th>
                    <th className="text-right">Wasted</th>
                    <th className="text-right">Rejected</th>
                    <th className="text-right">Returned</th>
                    <th className="text-right">Plant On-Hand</th>
                  </tr>
                </thead>
                <tbody>
                  {balance.items.map((it) => (
                    <tr key={it.itemId}>
                      <td className="font-bold text-slate-800">{it.itemName}</td>
                      <td className="text-right font-mono text-slate-600">
                        {it.consumedQty} {it.unit}
                      </td>
                      <td className="text-right font-mono text-amber-600">
                        {it.wastedQty} {it.unit}
                      </td>
                      <td className="text-right font-mono text-rose-600">
                        {it.rejectedQty} {it.unit}
                      </td>
                      <td className="text-right font-mono text-slate-600">
                        {it.returnedQty} {it.unit}
                      </td>
                      <td className="text-right font-mono font-bold text-slate-800" title="Whole-Plant on hand, not scoped to just this run — several runs can share the same physical stock.">
                        {it.plantOnHand} {it.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400">Plant On-Hand is whole-Plant, not per-run — other runs may share the same physical stock.</p>
          </div>
        )}
      </div>

      {canRecord && <EntryForm preProductionId={run.id} plantId={plantId} />}
    </div>
  );
}

function EntryForm({ preProductionId, plantId }: { preProductionId: string; plantId: string }) {
  const toast = useToast();
  const { data: plantStock } = usePlantStock(plantId);
  const { data: dayStores } = useDayStores();
  const record = useRecordPlantConsumption(preProductionId);

  const [itemId, setItemId] = useState("");
  const [unit, setUnit] = useState("");
  const [consumedQty, setConsumedQty] = useState("");
  const [wastedQty, setWastedQty] = useState("");
  const [rejectedQty, setRejectedQty] = useState("");
  const [returnedQty, setReturnedQty] = useState("");
  const [destinationType, setDestinationType] = useState<"DAY_STORE" | "WAREHOUSE">("WAREHOUSE");
  const [destDayStoreId, setDestDayStoreId] = useState("");
  const [note, setNote] = useState("");

  const stockItems = (plantStock?.stock ?? []).map((line) => ({ id: line.item.id, name: `${line.item.name} (${line.onHand} ${line.item.unit ?? ""} on hand)`.trim(), unit: line.item.unit }));

  function reset() {
    setItemId("");
    setUnit("");
    setConsumedQty("");
    setWastedQty("");
    setRejectedQty("");
    setReturnedQty("");
    setDestDayStoreId("");
    setNote("");
  }

  async function submit() {
    if (!itemId) return toast.error("Select an item.");
    const consumed = Number(consumedQty) || 0;
    const wasted = Number(wastedQty) || 0;
    const rejected = Number(rejectedQty) || 0;
    const returned = Number(returnedQty) || 0;
    if (consumed + wasted + rejected + returned <= 0) return toast.error("Enter at least one quantity greater than zero.");
    if (returned > 0 && destinationType === "DAY_STORE" && !destDayStoreId) return toast.error("Select a destination Day Store for the return.");

    const body: RecordPlantConsumptionPayload = {
      itemId,
      consumedQty: consumed,
      wastedQty: wasted,
      rejectedQty: rejected,
      returnedQty: returned,
      unit: unit.trim() || (stockItems.find((i) => i.id === itemId)?.unit ?? ""),
      destinationType: returned > 0 ? destinationType : undefined,
      destDayStoreId: returned > 0 && destinationType === "DAY_STORE" ? destDayStoreId : undefined,
      note: note.trim() || undefined,
    };
    try {
      await record.mutateAsync(body);
      toast.success(returned > 0 ? "Logged — the return is now pending the store's confirmation." : "Logged.");
      reset();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not record this entry");
    }
  }

  return (
    <div className="card space-y-4 p-5 sm:p-6">
      <p className="label !mb-0">Record Entry</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className="label">
            Item <span className="text-rose-500">*</span>
          </label>
          <ItemPicker
            items={stockItems}
            value={itemId}
            onChange={(v) => {
              const picked = stockItems.find((i) => i.id === v) as { unit?: string | null } | undefined;
              setItemId(v);
              if (picked?.unit) setUnit(picked.unit);
            }}
            placeholder="— Select an item on hand at this Plant —"
          />
        </div>
        <div>
          <label className="label">Unit</label>
          <input className="field" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div>
          <label className="label">Consumed</label>
          <input className="field font-mono" type="number" min="0" step="any" value={consumedQty} onChange={(e) => setConsumedQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Wasted</label>
          <input className="field font-mono" type="number" min="0" step="any" value={wastedQty} onChange={(e) => setWastedQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Rejected</label>
          <input className="field font-mono" type="number" min="0" step="any" value={rejectedQty} onChange={(e) => setRejectedQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Returned</label>
          <input className="field font-mono" type="number" min="0" step="any" value={returnedQty} onChange={(e) => setReturnedQty(e.target.value)} />
        </div>
        {Number(returnedQty) > 0 && (
          <>
            <div>
              <label className="label">Return To</label>
              <ItemPicker
                items={[
                  { id: "WAREHOUSE", name: "Warehouse" },
                  { id: "DAY_STORE", name: "A Day Store" },
                ]}
                value={destinationType}
                onChange={(v) => setDestinationType(v as "DAY_STORE" | "WAREHOUSE")}
                clearable={false}
              />
            </div>
            {destinationType === "DAY_STORE" && (
              <div>
                <label className="label">Day Store</label>
                <ItemPicker items={(dayStores ?? []).map((d) => ({ id: d.id, name: d.name }))} value={destDayStoreId} onChange={setDestDayStoreId} placeholder="— Select a Day Store —" />
              </div>
            )}
          </>
        )}
        <div className="sm:col-span-3">
          <label className="label">Note (optional)</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <button className="btn-primary" disabled={record.isPending} onClick={submit}>
        {record.isPending ? "Logging…" : "Log Entry"}
      </button>
    </div>
  );
}
