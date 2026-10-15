import { useState } from "react";
import { Plus, Shapes, X } from "lucide-react";
import { ItemPicker } from "./ItemPicker";
import { useCreateProductCategory, useProductCategories } from "../lib/hooks";
import { ApiError } from "../lib/api";

// The PO line's mandatory Product Category (Powder / Gummies / Bars / ...).
// Value is the category *name* — that's what the line stores. "+ New" adds a
// category to the shared master list, so once BD adds one it's a normal
// option for everyone from then on. Compact (no <label>) to sit in a product
// row alongside the other bare-placeholder fields.
export function ProductCategoryPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const { data: categories } = useProductCategories();
  const createCategory = useCreateProductCategory();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setError(null);
    const name = newName.trim();
    if (!name) return setError("Enter a category name.");
    try {
      const created = await createCategory.mutateAsync(name);
      onChange(created.name);
      setShowNew(false);
      setNewName("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the category");
    }
  }

  if (showNew) {
    return (
      <div>
        <div className="flex gap-1.5">
          <input
            className="field min-w-0 flex-1"
            placeholder="New product category"
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
          />
          <button type="button" className="btn-primary btn-sm shrink-0" disabled={createCategory.isPending} onClick={handleAdd}>
            {createCategory.isPending ? "Adding…" : "Add"}
          </button>
          <button type="button" className="btn-icon shrink-0" title="Cancel" onClick={() => setShowNew(false)}>
            <X className="h-3.5 w-3.5" strokeWidth={2.25} />
          </button>
        </div>
        {error && <p className="mt-1 text-tiny font-bold text-rose-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex gap-1.5">
      <div className="min-w-0 flex-1">
        <ItemPicker
          items={(categories ?? []).map((c) => ({ id: c.name, name: c.name }))}
          value={value}
          onChange={onChange}
          placeholder="Product Category *"
          icon={Shapes}
          clearable={false}
        />
      </div>
      <button type="button" className="btn-ghost btn-sm shrink-0" title="Add a new product category" onClick={() => setShowNew(true)}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New
      </button>
    </div>
  );
}
