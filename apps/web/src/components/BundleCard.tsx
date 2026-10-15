import type { ReactNode } from "react";
import { AlarmClock, Package } from "lucide-react";

/** One bundle = one product's materials. The same card is used by the Day Store's and the Warehouse's plan lists. */
export function BundleCard({
  title,
  subtitle,
  neededBy,
  overdue,
  chips,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  neededBy: string | null;
  overdue: boolean;
  /** Short facts under the title, e.g. "5 materials", "2 short". */
  chips: { label: string; tone?: "default" | "good" | "warn" | "bad" }[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const tone = {
    default: "border-slate-200 bg-slate-50 text-slate-600",
    good: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warn: "border-amber-200 bg-amber-50 text-amber-700",
    bad: "border-rose-200 bg-rose-50 text-rose-700",
  };
  return (
    <div className={`card overflow-hidden ${overdue ? "ring-1 ring-rose-200" : ""}`}>
      <div className={`flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5 ${overdue ? "bg-rose-50/50" : "bg-slate-50/60"}`}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-white p-2 text-brand-600 shadow-sm">
            <Package className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <p className="font-black text-slate-900">{title}</p>
            <p className="text-xs text-slate-500">{subtitle}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <span key={c.label} className={`pill ${tone[c.tone ?? "default"]}`}>
                  {c.label}
                </span>
              ))}
              {neededBy && (
                <span className={`inline-flex items-center gap-1 text-tiny font-bold ${overdue ? "text-rose-700" : "text-slate-500"}`}>
                  {overdue && <AlarmClock className="h-3 w-3" strokeWidth={2.5} />} Needed by {neededBy}
                  {overdue ? " (Overdue)" : ""}
                </span>
              )}
            </div>
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}
