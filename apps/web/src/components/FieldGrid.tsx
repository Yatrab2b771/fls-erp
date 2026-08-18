export interface FieldDef {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select";
  options?: readonly string[];
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
            <select
              className="field"
              disabled={disabled}
              value={values[field.name] ?? ""}
              onChange={(e) => onChange?.(field.name, e.target.value)}
            >
              <option value="">—</option>
              {field.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
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
