import { useState } from "react";
import { ArrowRightLeft, Check, Send, Truck, Warehouse as WarehouseIcon } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useCancelStockTransfer,
  useConfirmStockTransfer,
  useCreateStockTransfer,
  useDayStores,
  useDayStoreStock,
  usePlants,
  useStockTransfers,
  type CreateStockTransferPayload,
} from "../lib/hooks";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { StockTransfer, StockTransferDestinationType } from "../lib/types";

const DESTINATION_OPTIONS: { id: StockTransferDestinationType; name: string }[] = [
  { id: "DAY_STORE", name: "Another Day Store" },
  { id: "WAREHOUSE", name: "Warehouse" },
  { id: "PLANT", name: "Plant" },
];

function StatusPill({ status }: { status: StockTransfer["status"] }) {
  return (
    <span className={`pill ${status === "CONFIRMED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
      {status === "CONFIRMED" ? "Confirmed" : "Pending"}
    </span>
  );
}

function destinationLabel(t: StockTransfer): string {
  if (t.destinationType === "WAREHOUSE") return "Warehouse";
  if (t.destinationType === "DAY_STORE") return t.destDayStoreName ?? "—";
  return t.destPlantName ?? "—";
}

// Day Store -> Day Store, Day Store -> Warehouse, or Day Store -> Plant —
// a direct store-to-store lane distinct from the Warehouse's own
// issue-to-store/issue-to-production flows (Inventory page) and from
// R&D's two-way lane (R&D Store page). Sender-creates/receiver-confirms,
// same shape as both of those.
export function StockTransfersPage() {
  const { hasRole } = useAuth();
  const canSend = hasRole("STORE");
  const canConfirmDayStoreOrWarehouse = hasRole("STORE");
  const canConfirmPlant = hasRole("PRODUCTION");

  const { data: pending, isLoading: pendingLoading } = useStockTransfers("PENDING");
  const { data: all, isLoading: allLoading } = useStockTransfers();

  const myPending = (pending ?? []).filter((t) => (t.destinationType === "PLANT" ? canConfirmPlant : canConfirmDayStoreOrWarehouse));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <ArrowRightLeft className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Stock Transfers</h1>
          <p className="text-sm text-slate-500">Move RM/PM directly between Day Stores, back to the Warehouse, or on to a Plant.</p>
        </div>
      </div>

      {canSend && <SendTransferForm />}

      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Check className="h-3.5 w-3.5" /> Pending Confirmation
        </h2>
        {pendingLoading ? (
          <SkeletonRows rows={2} cols={4} />
        ) : !myPending.length ? (
          <p className="text-xs text-slate-400">Nothing waiting on you right now.</p>
        ) : (
          <div className="space-y-2">
            {myPending.map((t) => (
              <PendingTransferCard key={t.id} transfer={t} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Truck className="h-3.5 w-3.5" /> Recent Transfers
        </h2>
        {allLoading ? (
          <SkeletonRows rows={4} cols={6} />
        ) : !all?.length ? (
          <EmptyState icon={ArrowRightLeft} title="No transfers yet" hint={canSend ? "Send one above to get started." : "Nothing has been sent between stores yet."} accent="brand" />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-modern w-full">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Qty</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Sent</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((t) => (
                    <tr key={t.id}>
                      <td className="font-bold text-slate-800">{t.itemName}</td>
                      <td className="text-right font-mono text-slate-700">
                        {t.quantity} {t.unit}
                      </td>
                      <td className="text-slate-600">{t.sourceDayStoreName}</td>
                      <td className="text-slate-600">{destinationLabel(t)}</td>
                      <td className="text-slate-500">{new Date(t.sentAt).toLocaleDateString()}</td>
                      <td>
                        <StatusPill status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PendingTransferCard({ transfer }: { transfer: StockTransfer }) {
  const toast = useToast();
  const confirm = useConfirmStockTransfer();
  const cancel = useCancelStockTransfer();
  const { hasRole, user } = useAuth();
  const canCancel = transfer.sentByName === user?.fullName || hasRole("ADMIN");

  async function doConfirm() {
    try {
      await confirm.mutateAsync(transfer.id);
      toast.success(`Confirmed ${transfer.quantity} ${transfer.unit} of ${transfer.itemName}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not confirm receipt");
    }
  }

  async function doCancel() {
    if (!window.confirm(`Undo this send of ${transfer.itemName}? The material returns to ${transfer.sourceDayStoreName}'s stock.`)) return;
    try {
      await cancel.mutateAsync(transfer.id);
      toast.success("Transfer undone.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not undo this transfer");
    }
  }

  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <p className="font-bold text-slate-800">
          {transfer.quantity} {transfer.unit} {transfer.itemName}
        </p>
        <p className="text-xs text-slate-500">
          {transfer.sourceDayStoreName} → {destinationLabel(transfer)} · sent by {transfer.sentByName} on {new Date(transfer.sentAt).toLocaleDateString()}
        </p>
        {transfer.note && <p className="mt-1 text-xs text-slate-400">"{transfer.note}"</p>}
      </div>
      <div className="flex gap-2">
        <button className="btn-primary btn-sm" disabled={confirm.isPending} onClick={doConfirm}>
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> {confirm.isPending ? "Confirming…" : "Confirm Receipt"}
        </button>
        {canCancel && (
          <button className="btn-ghost btn-sm" disabled={cancel.isPending} onClick={doCancel}>
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

function SendTransferForm() {
  const toast = useToast();
  const { data: dayStores } = useDayStores();
  const { data: plants } = usePlants();
  const createTransfer = useCreateStockTransfer();

  const [sourceDayStoreId, setSourceDayStoreId] = useState("");
  const { data: sourceStock } = useDayStoreStock(sourceDayStoreId || undefined);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [destinationType, setDestinationType] = useState<StockTransferDestinationType>("DAY_STORE");
  const [destDayStoreId, setDestDayStoreId] = useState("");
  const [destPlantId, setDestPlantId] = useState("");
  const [note, setNote] = useState("");

  const stockItems = (sourceStock?.stock ?? []).map((line) => ({ id: line.item.id, name: `${line.item.name} (${line.onHand} ${line.item.unit ?? ""} on hand)`.trim(), unit: line.item.unit }));
  const destDayStoreOptions = (dayStores ?? []).filter((d) => d.id !== sourceDayStoreId).map((d) => ({ id: d.id, name: d.name }));

  function reset() {
    setItemId("");
    setQuantity("");
    setUnit("");
    setDestDayStoreId("");
    setDestPlantId("");
    setNote("");
  }

  async function submit() {
    if (!sourceDayStoreId || !itemId || !quantity) {
      toast.error("Select a source store, an item, and a quantity.");
      return;
    }
    if (destinationType === "DAY_STORE" && !destDayStoreId) return toast.error("Select a destination Day Store.");
    if (destinationType === "PLANT" && !destPlantId) return toast.error("Select a destination Plant.");

    const body: CreateStockTransferPayload = {
      itemId,
      quantity: Number(quantity),
      unit: unit.trim() || (sourceStock?.stock.find((l) => l.item.id === itemId)?.item.unit ?? ""),
      note: note.trim() || undefined,
      sourceType: "DAY_STORE",
      sourceDayStoreId,
      destinationType,
      destDayStoreId: destinationType === "DAY_STORE" ? destDayStoreId : undefined,
      destPlantId: destinationType === "PLANT" ? destPlantId : undefined,
    };
    try {
      await createTransfer.mutateAsync(body);
      toast.success(`Sent ${body.quantity} ${body.unit} — waiting on the other side to confirm.`);
      reset();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send transfer");
    }
  }

  return (
    <div className="card space-y-4 p-5 sm:p-6">
      <p className="label !mb-0 flex items-center gap-1.5">
        <Send className="h-3.5 w-3.5" /> Send Material
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label">
            From (Day Store) <span className="text-rose-500">*</span>
          </label>
          <ItemPicker
            items={(dayStores ?? []).map((d) => ({ id: d.id, name: d.name }))}
            value={sourceDayStoreId}
            onChange={(v) => {
              setSourceDayStoreId(v);
              setItemId("");
            }}
            placeholder="— Select a Day Store —"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label">
            Item <span className="text-rose-500">*</span>
          </label>
          <ItemPicker
            items={stockItems}
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              const picked = stockItems.find((i) => i.id === v) as { unit?: string | null } | undefined;
              if (picked?.unit) setUnit(picked.unit);
            }}
            placeholder={sourceDayStoreId ? "— Select an item on hand —" : "Pick a source store first"}
            disabled={!sourceDayStoreId}
          />
        </div>
        <div>
          <label className="label">
            Quantity <span className="text-rose-500">*</span>
          </label>
          <input className="field font-mono" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="label">Unit</label>
          <input className="field" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div>
          <label className="label">
            Destination <span className="text-rose-500">*</span>
          </label>
          <ItemPicker items={DESTINATION_OPTIONS} value={destinationType} onChange={(v) => setDestinationType(v as StockTransferDestinationType)} clearable={false} icon={WarehouseIcon} />
        </div>
        {destinationType === "DAY_STORE" && (
          <div>
            <label className="label">
              Destination Day Store <span className="text-rose-500">*</span>
            </label>
            <ItemPicker items={destDayStoreOptions} value={destDayStoreId} onChange={setDestDayStoreId} placeholder="— Select a Day Store —" />
          </div>
        )}
        {destinationType === "PLANT" && (
          <div>
            <label className="label">
              Destination Plant <span className="text-rose-500">*</span>
            </label>
            <ItemPicker items={(plants ?? []).map((p) => ({ id: p.id, name: p.name }))} value={destPlantId} onChange={setDestPlantId} placeholder="— Select a Plant —" />
          </div>
        )}
        <div className="sm:col-span-3">
          <label className="label">Note (optional)</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <button className="btn-primary" disabled={createTransfer.isPending} onClick={submit}>
        {createTransfer.isPending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
