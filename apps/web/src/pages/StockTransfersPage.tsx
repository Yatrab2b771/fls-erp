import { useState } from "react";
import { ArrowRightLeft, Check, Send, Truck, Warehouse as WarehouseIcon } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCancelStockTransfer, useConfirmStockTransfer, useCreateStockTransfer, useDayStoreStock, useMyStoreInfo, useStockTransfers, type CreateStockTransferPayload } from "../lib/hooks";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import { fmtQty } from "../lib/format";
import type { StockTransfer, StockTransferDestinationType } from "../lib/types";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";

function StatusPill({ status }: { status: StockTransfer["status"] }) {
  return (
    <span className={`pill ${status === "CONFIRMED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
      {status === "CONFIRMED" ? "Confirmed" : "Pending"}
    </span>
  );
}

const sourceLabel = (t: StockTransfer): string => t.sourceDayStoreName ?? t.sourcePlantName ?? "—";

function destinationLabel(t: StockTransfer): string {
  if (t.destinationType === "WAREHOUSE") return "Warehouse";
  if (t.destinationType === "DAY_STORE") return t.destDayStoreName ?? "—";
  return t.destPlantName ?? "—";
}

// A Day Store sends back unused RM / PM to the Warehouse, or on to its own Plant - never to another store. The
// Warehouse does not send from a Day Store (it issues stock out from the Stock Issued screen); here it only
// receives and confirms what comes back. Sender creates, receiver confirms: the Warehouse confirms a return, Production
// confirms what reaches a Plant.
export function StockTransfersPage() {
  const { hasRole } = useAuth();
  const { data: info } = useMyStoreInfo({ enabled: hasRole("STORE") });
  const dayStoreLogin = info?.scoped === true;
  const warehouseSeat = !!info && !info.scoped && hasRole("STORE") && !hasRole("ADMIN");
  const canSend = dayStoreLogin || hasRole("ADMIN");
  const canConfirmWarehouse = !dayStoreLogin && hasRole("STORE");
  const canConfirmPlant = hasRole("PRODUCTION");

  const { data: pending, isLoading: pendingLoading } = useStockTransfers("PENDING");
  const { data: all, isLoading: allLoading } = useStockTransfers();

  // What waits on this person: a return to the Warehouse (Warehouse seat) or a send to a Plant (Production). A Day
  // Store login has nothing to confirm - it sees what it has sent that is still on its way.
  const waiting = (pending ?? []).filter((t) => (dayStoreLogin ? true : t.destinationType === "PLANT" ? canConfirmPlant : canConfirmWarehouse));
  const pg = useClientPaging(all);

  const title = dayStoreLogin ? "Send / Return Stock" : warehouseSeat ? "Stock Returns" : "Stock Transfers";
  const blurb = dayStoreLogin
    ? "Send unused RM/PM back to the Warehouse, or on to your own Plant."
    : warehouseSeat
      ? "Stock that Day Stores have sent back to the Warehouse - confirm it when it arrives."
      : "Stock moving between a Day Store, its Plant and the Warehouse.";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <ArrowRightLeft className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">{title}</h1>
          <p className="text-sm text-slate-500">{blurb}</p>
        </div>
      </div>

      {canSend && info && <SendTransferForm stores={info.stores} />}

      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-tiny font-bold uppercase tracking-wider text-slate-400">
          <Check className="h-3.5 w-3.5" /> {dayStoreLogin ? "On its way" : "Pending Confirmation"}
        </h2>
        {pendingLoading ? (
          <SkeletonRows rows={2} cols={4} />
        ) : !waiting.length ? (
          <p className="text-xs text-slate-400">{dayStoreLogin ? "Nothing of yours is waiting to be received." : "Nothing waiting on you right now."}</p>
        ) : (
          <PendingTransfersTable rows={waiting} canConfirm={!dayStoreLogin} />
        )}
      </div>

      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-tiny font-bold uppercase tracking-wider text-slate-400">
          <Truck className="h-3.5 w-3.5" /> Recent Transfers
        </h2>
        {allLoading ? (
          <SkeletonRows rows={4} cols={6} />
        ) : !all?.length ? (
          <EmptyState icon={ArrowRightLeft} title="No transfers yet" hint={canSend ? "Send one above to get started." : "Nothing has been sent back yet."} accent="brand" />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-modern w-full">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th className="text-right">Qty</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.rows.map((t) => (
                    <tr key={t.id}>
                      <td className="font-bold text-slate-800">{t.itemName}</td>
                      <td>
                        <StatusPill status={t.status} />
                      </td>
                      <td className="text-right font-mono text-slate-700">
                        {fmtQty(t.quantity)} {t.unit}
                      </td>
                      <td className="text-slate-600">{sourceLabel(t)}</td>
                      <td className="text-slate-600">{destinationLabel(t)}</td>
                      <td className="text-slate-500">{new Date(t.sentAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ClientPager pg={pg} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Transfers waiting to be received, as one table: a column for each thing, and Confirm Receipt / Undo in the last column.
function PendingTransfersTable({ rows, canConfirm }: { rows: StockTransfer[]; canConfirm: boolean }) {
  const pg = useClientPaging(rows);
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3">From</th>
              <th className="px-4 py-3">To</th>
              <th className="px-4 py-3">Sent By</th>
              <th className="px-4 py-3">Sent On</th>
              <th className="px-4 py-3">Note</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pg.rows.map((t) => (
              <PendingTransferRow key={t.id} transfer={t} canConfirm={canConfirm} />
            ))}
          </tbody>
        </table>
      </div>
      <ClientPager pg={pg} />
    </div>
  );
}

function PendingTransferRow({ transfer, canConfirm }: { transfer: StockTransfer; canConfirm: boolean }) {
  const toast = useToast();
  const confirm = useConfirmStockTransfer();
  const cancel = useCancelStockTransfer();
  const { hasRole, user } = useAuth();
  const canCancel = transfer.sentByName === user?.fullName || hasRole("ADMIN");

  async function doConfirm() {
    try {
      await confirm.mutateAsync(transfer.id);
      toast.success(`Confirmed ${fmtQty(transfer.quantity)} ${transfer.unit} of ${transfer.itemName}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not confirm receipt");
    }
  }

  async function doCancel() {
    if (!window.confirm(`Undo this send of ${transfer.itemName}? The material returns to the sender's stock.`)) return;
    try {
      await cancel.mutateAsync(transfer.id);
      toast.success("Transfer undone.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not undo this transfer");
    }
  }

  return (
    <tr className="transition hover:bg-slate-50">
      <td className="px-4 py-3 font-bold text-slate-800">{transfer.itemName}</td>
      <td className="px-4 py-3 text-right font-mono text-slate-700">
        {fmtQty(transfer.quantity)} {transfer.unit}
      </td>
      <td className="px-4 py-3 text-slate-600">{sourceLabel(transfer)}</td>
      <td className="px-4 py-3 text-slate-600">{destinationLabel(transfer)}</td>
      <td className="px-4 py-3 text-slate-600">{transfer.sentByName}</td>
      <td className="px-4 py-3 text-slate-600">{new Date(transfer.sentAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td>
      <td className="max-w-[16rem] truncate px-4 py-3 text-slate-500" title={transfer.note ?? ""}>
        {transfer.note ?? "-"}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex gap-1.5">
          {canConfirm && (
            <button className="btn-primary btn-sm" disabled={confirm.isPending} onClick={doConfirm}>
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> {confirm.isPending ? "Confirming…" : "Confirm Receipt"}
            </button>
          )}
          {canCancel && (
            <button className="btn-ghost btn-sm" disabled={cancel.isPending} onClick={doCancel}>
              Undo
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// A Day Store login's send form: from its own store (picked only if it is assigned to more than one), to the
// Warehouse or to that store's own Plant.
function SendTransferForm({ stores }: { stores: { id: string; name: string; plantId: string | null; plantName: string | null }[] }) {
  const toast = useToast();
  const createTransfer = useCreateStockTransfer();

  const [pickedStoreId, setPickedStoreId] = useState("");
  const store = stores.length === 1 ? stores[0] : stores.find((s) => s.id === pickedStoreId);
  const { data: sourceStock } = useDayStoreStock(store?.id);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [destinationType, setDestinationType] = useState<StockTransferDestinationType>("WAREHOUSE");
  const [note, setNote] = useState("");

  const destinationOptions: { id: StockTransferDestinationType; name: string }[] = [
    { id: "WAREHOUSE", name: "Warehouse (return)" },
    { id: "PLANT", name: store?.plantName ? `My Plant — ${store.plantName}` : "My Plant" },
  ];
  const stockItems = (sourceStock?.stock ?? []).filter((line) => line.onHand > 1e-6).map((line) => ({ id: line.item.id, name: `${line.item.name} (${fmtQty(line.onHand)} ${line.item.unit ?? ""} on hand)`.trim(), unit: line.item.unit }));

  function reset() {
    setItemId("");
    setQuantity("");
    setUnit("");
    setNote("");
  }

  async function submit() {
    if (!store || !itemId || !quantity) {
      toast.error("Select your store, an item, and a quantity.");
      return;
    }
    if (destinationType === "PLANT" && !store.plantId) return toast.error("This store has no Plant of its own to send to.");

    const body: CreateStockTransferPayload = {
      itemId,
      quantity: Number(quantity),
      unit: unit.trim() || (sourceStock?.stock.find((l) => l.item.id === itemId)?.item.unit ?? ""),
      note: note.trim() || undefined,
      sourceType: "DAY_STORE",
      sourceDayStoreId: store.id,
      destinationType,
      destPlantId: destinationType === "PLANT" ? (store.plantId ?? undefined) : undefined,
    };
    try {
      await createTransfer.mutateAsync(body);
      toast.success(`Sent ${fmtQty(body.quantity)} ${body.unit} — waiting on the other side to confirm.`);
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
            From <span className="text-rose-500">*</span>
          </label>
          {stores.length === 1 ? (
            <div className="field flex items-center bg-slate-50 font-semibold text-slate-700">{stores[0]!.name}</div>
          ) : (
            <ItemPicker
              items={stores.map((d) => ({ id: d.id, name: d.name }))}
              value={pickedStoreId}
              onChange={(v) => {
                setPickedStoreId(v);
                setItemId("");
              }}
              placeholder="— Select your Day Store —"
            />
          )}
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
            placeholder={store ? "— Select an item on hand —" : "Pick your store first"}
            disabled={!store}
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
            Send to <span className="text-rose-500">*</span>
          </label>
          <ItemPicker items={destinationOptions} value={destinationType} onChange={(v) => setDestinationType(v as StockTransferDestinationType)} clearable={false} icon={WarehouseIcon} />
        </div>
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
