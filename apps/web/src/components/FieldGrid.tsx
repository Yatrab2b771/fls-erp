import { ItemPicker } from "./ItemPicker";

export interface FieldDef {
  name: string;
  label: string;
  // "tel" restricts keystrokes to digits, capped at 10 — the "only 10
  // numbers" phone-field rule enforced at the UI layer, not just on
  // save. "email" is a plain HTML5 email input (browser-level format
  // hint); the real validation still happens on save/server, this is
  // just the affordance.
  type: "text" | "number" | "date" | "select" | "combo" | "tel" | "email";
  options?: readonly string[];
}

// Digits only, capped at 10 — used by "tel" fields so a phone number
// field can only ever hold what it's meant to hold, not just get
// rejected after the fact on save.
function sanitizePhone(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

// The pure label+input grid rendering one stage's fields — shared by the
// batch pipeline's current-stage form (editable) and its history/read-only
// displays.
export function FieldGrid({
  fields,
  values,
  onChange,
  disabled = false,
}: {
  fields: FieldDef[];
  values: Record<string, string>;
  onChange?: (name: string, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.name}>
          <label className="label">{field.label}</label>
          {field.type === "select" ? (
            // A searchable combobox even for a short option list — same
            // component every other picker in the app uses (ItemPicker),
            // for one consistent "type to filter" feel everywhere,
            // instead of a plain <select> here and a search box
            // elsewhere. Option string doubles as its own id — there's
            // no separate id space for a fixed enum like this.
            <ItemPicker items={(field.options ?? []).map((opt) => ({ id: opt, name: opt }))} value={values[field.name] ?? ""} onChange={(v) => onChange?.(field.name, v)} disabled={disabled} />
          ) : field.type === "combo" ? (
            // A dropdown of the common phase names, but still free text —
            // this field describes whichever process step is underway
            // (e.g. "Blending"), which a strict <select> can't enumerate
            // for every product.
            <>
              <input
                list={`${field.name}-options`}
                className="field"
                disabled={disabled}
                value={values[field.name] ?? ""}
                onChange={(e) => onChange?.(field.name, e.target.value)}
              />
              <datalist id={`${field.name}-options`}>
                {field.options?.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
            </>
          ) : field.type === "tel" ? (
            <input
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              placeholder="10-digit number"
              className="field"
              disabled={disabled}
              value={values[field.name] ?? ""}
              onChange={(e) => onChange?.(field.name, sanitizePhone(e.target.value))}
            />
          ) : (
            <input
              type={field.type}
              step={field.type === "number" ? "any" : undefined}
              className="field"
              disabled={disabled}
              value={values[field.name] ?? ""}
              onChange={(e) => onChange?.(field.name, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
