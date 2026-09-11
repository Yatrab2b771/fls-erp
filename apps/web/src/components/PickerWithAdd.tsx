import { useState } from "react";
import { UserPlus, type LucideIcon } from "lucide-react";
import { ItemPicker } from "./ItemPicker";

// A searchable picker that can grow its own option list inline — same
// "+ New" toggle pattern as InventoryPage's item picker, generalized for
// any named lookup list (Day Store, Plant, ...) where "add one if it's
// not there yet" beats a separate admin screen. Optional — every caller
// treats an empty value as "not tagged", never a required field.
export function PickerWithAdd({
  label,
  placeholder,
  options,
  value,
  onChange,
  onCreate,
  disabled = false,
  // Per-row icon in the open list (Brand, Product, ...) — a plain text
  // list doesn't need one, a real named catalog reads better with one.
  icon,
  // UserPlus still fits "add a new customer/plant"; Plus reads better
  // once the thing being added isn't a person (Brand, Product, ...).
  addIcon: AddIcon = UserPlus,
}: {
  label: string;
  placeholder: string;
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  onCreate: (name: string) => Promise<{ id: string } | null>;
  disabled?: boolean;
  icon?: LucideIcon;
  addIcon?: LucideIcon;
}) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setError(null);
    if (!newName.trim()) return setError("Enter a name.");
    setCreating(true);
    try {
      const created = await onCreate(newName.trim());
      if (created) {
        onChange(created.id);
        setShowNew(false);
        setNewName("");
      }
    } catch {
      setError("Could not create — it may already exist.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <label className="label">{label}</label>
      {!showNew ? (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1">
            <ItemPicker items={options} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} icon={icon} />
          </div>
          {!disabled && (
            <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNew(true)}>
              <AddIcon className="h-3.5 w-3.5" strokeWidth={2.25} /> New
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input className="field min-w-0 flex-1" placeholder="Exact name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="btn-primary shrink-0" disabled={creating} onClick={handleCreate}>
            {creating ? "Adding…" : "Add"}
          </button>
          <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNew(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] font-bold text-rose-600">{error}</p>}
    </div>
  );
}
