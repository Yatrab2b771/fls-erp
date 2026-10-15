import { CUSTOMER_TYPES, LEAD_SOURCES, POWDER_TYPES, PRODUCT_FORMATS } from "../lib/leadHooks";

// The chip pickers a lead uses: several at a time (customer type, product format, powder type) or one at a time.

export function ChipMulti({ options, value, onChange, disabled, small }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; small?: boolean }) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => toggle(o)}
            className={`rounded-full border font-bold transition ${small ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs"} ${on ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"} ${disabled ? "cursor-default opacity-80" : ""}`}
          >
            {on && "✓ "}
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Customer type, product formats and (only when Powder is chosen) its powder types, as one block. */
export function LeadKindFields({
  customerTypes,
  productFormats,
  powderTypes,
  onChange,
  disabled,
}: {
  customerTypes: string[];
  productFormats: string[];
  powderTypes: string[];
  onChange: (next: { customerTypes: string[]; productFormats: string[]; powderTypes: string[] }) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<{ customerTypes: string[]; productFormats: string[]; powderTypes: string[] }>) => onChange({ customerTypes, productFormats, powderTypes, ...patch });
  const hasPowder = productFormats.includes("Powder");
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-700">
          Customer type <span className="font-medium text-slate-400">· select all that apply</span>
        </p>
        <ChipMulti options={CUSTOMER_TYPES} value={customerTypes} onChange={(v) => set({ customerTypes: v })} disabled={disabled} />
      </div>
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-700">
          Product formats <span className="font-medium text-slate-400">· select all that apply</span>
        </p>
        <ChipMulti options={PRODUCT_FORMATS} value={productFormats} onChange={(v) => set({ productFormats: v, powderTypes: v.includes("Powder") ? powderTypes : [] })} disabled={disabled} />
        {hasPowder && (
          <div className="mt-2 rounded-xl border border-dashed border-brand-300 bg-brand-50/40 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-bold text-brand-800">
              Powder type <span className="font-medium">· only for Powder</span>
            </p>
            <ChipMulti options={POWDER_TYPES} value={powderTypes} onChange={(v) => set({ powderTypes: v })} disabled={disabled} small />
          </div>
        )}
      </div>
    </div>
  );
}

export function LeadSourceSelect({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  return (
    <select className="field" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Not set</option>
      {LEAD_SOURCES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
