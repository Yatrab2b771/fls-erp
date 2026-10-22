import { useState } from "react";
import { Plus, Truck } from "lucide-react";
import { ApiError } from "../lib/api";
import { useCreateTransporter, useTransporters, type Transporter } from "../lib/transporterHooks";
import { ItemPicker } from "./ItemPicker";

const TYPED = "__typed";
const label = (t: Transporter) => (t.transporterId ? `${t.name} · ${t.transporterId}` : t.name);

// The Transport name of a shipment: picked from the transporters Dispatch has (name and Transporter ID), or a new one added right here. The shipment
// keeps the NAME as text, so `value` and `onChange` are the name; a name typed before this list existed (an older shipment) still shows.
export function TransporterPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const { data } = useTransporters();
  const create = useCreateTransporter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [transporterId, setTransporterId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const list = data ?? [];
  const typed = value.trim();
  const current = list.find((t) => t.name.toLowerCase() === typed.toLowerCase());
  const items = [...list.map((t) => ({ id: t.id, name: label(t) })), ...(typed && !current ? [{ id: TYPED, name: typed }] : [])];

  function pick(id: string) {
    if (id === TYPED) return;
    onChange(list.find((t) => t.id === id)?.name ?? "");
  }

  async function add() {
    setError(null);
    if (!name.trim()) return setError("Enter the transporter's name.");
    try {
      const created = await create.mutateAsync({ name: name.trim(), transporterId: transporterId.trim() || undefined });
      onChange(created.name);
      setAdding(false);
      setName("");
      setTransporterId("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the transporter.");
    }
  }

  return (
    <div>
      <label className="mb-0.5 block text-micro text-slate-400">Transport name</label>
      {!adding ? (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <ItemPicker items={items} value={current?.id ?? (typed ? TYPED : "")} onChange={pick} placeholder="— Select a transporter —" icon={Truck} />
          </div>
          <button type="button" className="btn-ghost shrink-0" onClick={() => setAdding(true)} title="Add a transporter that is not in the list">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} /> New
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <input className="field !py-1.5 text-xs" placeholder="Transporter name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input className="field !py-1.5 font-mono text-xs" placeholder="Transporter ID (15 characters, optional)" value={transporterId} onChange={(e) => setTransporterId(e.target.value.toUpperCase())} maxLength={40} />
          <div className="flex gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={add}>
              {create.isPending ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-tiny font-bold text-rose-600">{error}</p>}
    </div>
  );
}
