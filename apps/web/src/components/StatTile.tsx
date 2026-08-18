import type { LucideIcon } from "lucide-react";

const ACCENT_CLASSES: Record<string, { bg: string; text: string }> = {
  brand: { bg: "bg-brand-50", text: "text-brand-600" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600" },
  amber: { bg: "bg-amber-50", text: "text-amber-600" },
  rose: { bg: "bg-rose-50", text: "text-rose-600" },
  violet: { bg: "bg-violet-50", text: "text-violet-600" },
  blue: { bg: "bg-blue-50", text: "text-blue-600" },
  slate: { bg: "bg-slate-100", text: "text-slate-500" },
};

export function StatTile({ icon: Icon, label, value, accent = "brand" }: { icon: LucideIcon; label: string; value: string | number; accent?: keyof typeof ACCENT_CLASSES }) {
  const classes = ACCENT_CLASSES[accent] ?? ACCENT_CLASSES.brand!;
  return (
    <div className="stat-tile">
      <div className={`stat-icon ${classes.bg} ${classes.text}`}>
        <Icon className="h-5 w-5" strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-black leading-none tracking-tight text-slate-900">{value}</p>
        <p className="mt-1 truncate text-[10.5px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      </div>
    </div>
  );
}
